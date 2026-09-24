import { AltSuggestionDto, PlannedChange } from "../../shared/types";
import { config } from "../config";
import { db } from "../db";
import { getAssetRow, listAssets } from "./asset-sync";
import { HttpError } from "./errors";
import { logOp } from "./oplog";
import { getClient } from "./webflow-client";

export interface AltTextInput {
  assetId: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  imageUrl: string;
  folderPath: string;
}

/** Suggestion provider adapter. */
export interface AltTextProvider {
  readonly name: string;
  suggest(input: AltTextInput): Promise<string>;
}

/** Deterministic offline provider: derives a readable phrase from the file name, type and shape. */
export class MockAltTextProvider implements AltTextProvider {
  readonly name = "mock";

  async suggest(input: AltTextInput): Promise<string> {
    const base = input.fileName.replace(/\.[a-z0-9]+$/i, "");
    const words = base
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_\-.]+/g, " ")
      .replace(/\b(img|dsc|image|screenshot|copy|final|v\d+)\b/gi, " ")
      .replace(/\b\d{3,}\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const kind = input.mimeType.includes("svg") ? "Illustration" : input.mimeType.includes("gif") ? "Animation" : "Photo";
    let shape = "";
    if (input.width && input.height) shape = input.width > input.height * 1.2 ? " (landscape)" : input.height > input.width * 1.2 ? " (portrait)" : " (square)";
    const subject = words || (input.folderPath ? input.folderPath.split("/").pop()?.toLowerCase() ?? "image" : "image");
    return `${kind} of ${subject}${shape}`;
  }
}

/** Calls any HTTP service: POST {imageUrl,fileName,mimeType,width,height,folderPath} -> {altText}. */
export class HttpAltTextProvider implements AltTextProvider {
  readonly name = "http";

  constructor(private url: string, private apiKey: string) {}

  async suggest(input: AltTextInput): Promise<string> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`Alt-text provider responded ${res.status}`);
    const json = (await res.json()) as { altText?: string };
    if (!json.altText || !json.altText.trim()) throw new Error("Alt-text provider returned no altText");
    return json.altText.trim().slice(0, 500);
  }
}

let provider: AltTextProvider | null = null;

export function getAltTextProvider(): AltTextProvider {
  if (!provider) {
    provider = config.altText.provider === "http" && config.altText.httpUrl ? new HttpAltTextProvider(config.altText.httpUrl, config.altText.httpKey) : new MockAltTextProvider();
  }
  return provider;
}

export function setAltTextProvider(p: AltTextProvider): void {
  provider = p;
}

export interface SuggestResult {
  created: number;
  failed: number;
}

/** Creates pending suggestions for the given assets (default: every image missing alt text without a pending suggestion). */
export async function generateSuggestions(siteId: string, assetIds?: string[]): Promise<SuggestResult> {
  const p = getAltTextProvider();
  const candidates = listAssets(siteId).filter((a) => a.mimeType.startsWith("image/") && (assetIds ? assetIds.includes(a.assetId) : a.altStatus === "missing"));
  const result: SuggestResult = { created: 0, failed: 0 };
  for (const a of candidates) {
    if (a.altStatus === "suggested") continue;
    try {
      const text = await p.suggest({ assetId: a.assetId, fileName: a.originalFileName || a.displayName, mimeType: a.mimeType, width: a.width, height: a.height, imageUrl: a.hostedUrl, folderPath: a.folderPath });
      db.run(`INSERT INTO alt_suggestions (site_id, asset_id, suggestion, provider) VALUES (?, ?, ?, ?)`, [siteId, a.assetId, text, p.name]);
      result.created++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

export function listSuggestions(siteId: string, status?: string): AltSuggestionDto[] {
  const params: Array<string | number> = [siteId];
  let extra = "";
  if (status) {
    extra = " AND s.status = ?";
    params.push(status);
  }
  return db.all<AltSuggestionDto>(
    `SELECT s.id AS id, s.asset_id AS assetId, COALESCE(a.display_name, s.asset_id) AS displayName, COALESCE(a.hosted_url, '') AS hostedUrl,
            s.suggestion AS suggestion, s.provider AS provider, s.status AS status
       FROM alt_suggestions s LEFT JOIN assets a ON a.site_id = s.site_id AND a.asset_id = s.asset_id
      WHERE s.site_id = ?${extra} ORDER BY s.id DESC`,
    params
  );
}

interface SuggestionRow {
  id: number;
  asset_id: string;
  suggestion: string;
  status: string;
}

function loadPending(siteId: string, id: number): SuggestionRow {
  const row = db.get<SuggestionRow>(`SELECT id, asset_id, suggestion, status FROM alt_suggestions WHERE site_id = ? AND id = ?`, [siteId, id]);
  if (!row) throw new HttpError(404, `Suggestion ${id} not found`);
  if (row.status !== "pending") throw new HttpError(409, `Suggestion ${id} is already ${row.status}`);
  return row;
}

/** Reviewer approval: optionally edited text is written back via PATCH /v2/assets/{id}. Dry runs only report the change. */
export async function approveSuggestion(siteId: string, id: number, editedText: string | undefined, dryRun: boolean): Promise<PlannedChange> {
  const row = loadPending(siteId, id);
  const text = (editedText ?? row.suggestion).trim();
  if (!text) throw new HttpError(400, "Alt text cannot be empty");
  const asset = getAssetRow(siteId, row.asset_id);
  const change: PlannedChange = { assetId: row.asset_id, before: asset.altText, after: text, applied: false };
  if (!dryRun) {
    await getClient(siteId).updateAsset(row.asset_id, { altText: text });
    db.transaction(() => {
      db.run(`UPDATE assets SET alt_text = ? WHERE site_id = ? AND asset_id = ?`, [text, siteId, row.asset_id]);
      db.run(`UPDATE alt_suggestions SET status = 'approved', suggestion = ?, reviewed_at = datetime('now') WHERE site_id = ? AND id = ?`, [text, siteId, id]);
      db.run(`DELETE FROM audit_findings WHERE site_id = ? AND asset_id = ? AND kind = 'missing_alt'`, [siteId, row.asset_id]);
    });
    change.applied = true;
  }
  logOp(siteId, "alt_text", row.asset_id, change.before, change.after, dryRun);
  return change;
}

export function rejectSuggestion(siteId: string, id: number): void {
  loadPending(siteId, id);
  db.run(`UPDATE alt_suggestions SET status = 'rejected', reviewed_at = datetime('now') WHERE site_id = ? AND id = ?`, [siteId, id]);
}
