import { PlannedChange } from "../../shared/types";
import { db } from "../db";
import { listAssets } from "./asset-sync";
import { EXTENSIONS } from "./encoder";
import { ensureFolderPath, pathOfFolder } from "./folders";
import { HttpError } from "./errors";
import { renderTemplate, slugify, splitFileName, validateTemplate } from "./naming";
import { logOp } from "./oplog";
import { getClient } from "./webflow-client";

export interface RenameRequest {
  template: string;
  folderId?: string;
  /** Optional regex; only assets whose current display name matches are renamed (e.g. "^(IMG|DSC|Screenshot)"). */
  onlyMatching?: string;
  dryRun: boolean;
}

/** Bulk rename by naming-rule template. Tokens render the base name; the original extension is always preserved. */
export async function bulkRename(siteId: string, req: RenameRequest): Promise<PlannedChange[]> {
  validateTemplate(req.template);
  let filter: RegExp | null = null;
  if (req.onlyMatching) {
    try {
      filter = new RegExp(req.onlyMatching, "i");
    } catch {
      throw new HttpError(400, "onlyMatching is not a valid regular expression");
    }
  }
  const assets = listAssets(siteId, { folderId: req.folderId });
  const taken = new Set(assets.map((a) => a.displayName.toLowerCase()));
  const changes: PlannedChange[] = [];
  let index = 0;
  for (const a of assets) {
    if (filter && !filter.test(a.displayName)) continue;
    index++;
    const { name, ext: fileExt } = splitFileName(a.displayName || a.originalFileName);
    const ext = fileExt || EXTENSIONS[a.mimeType] || "";
    const base = slugify(renderTemplate(req.template, { name, ext, mimeType: a.mimeType, folderName: a.folderPath.split("/").pop() ?? "", width: a.width, height: a.height, createdOn: "", index })) || "asset";
    let candidate = ext ? `${base}.${ext}` : base;
    if (candidate.toLowerCase() === a.displayName.toLowerCase()) continue;
    let n = 2;
    while (taken.has(candidate.toLowerCase())) {
      candidate = ext ? `${base}-${n}.${ext}` : `${base}-${n}`;
      n++;
    }
    taken.add(candidate.toLowerCase());
    const change: PlannedChange = { assetId: a.assetId, before: a.displayName, after: candidate, applied: false };
    if (!req.dryRun) {
      try {
        await getClient(siteId).updateAsset(a.assetId, { displayName: candidate });
        db.run(`UPDATE assets SET display_name = ? WHERE site_id = ? AND asset_id = ?`, [candidate, siteId, a.assetId]);
        change.applied = true;
      } catch (err) {
        change.error = err instanceof Error ? err.message : String(err);
      }
    }
    logOp(siteId, "rename", a.assetId, change.before, change.after, req.dryRun);
    changes.push(change);
  }
  return changes;
}

export interface FolderOrganizeRequest {
  template: string;
  folderId?: string;
  dryRun: boolean;
}

/** Moves assets into folders derived from a path template such as "{type}/{year}"; missing folders are created. */
export async function organizeFolders(siteId: string, req: FolderOrganizeRequest): Promise<PlannedChange[]> {
  validateTemplate(req.template);
  const assets = listAssets(siteId, { folderId: req.folderId });
  const changes: PlannedChange[] = [];
  let index = 0;
  for (const a of assets) {
    index++;
    const { name, ext } = splitFileName(a.displayName || a.originalFileName);
    const raw = renderTemplate(req.template, { name, ext, mimeType: a.mimeType, folderName: a.folderPath.split("/").pop() ?? "", width: a.width, height: a.height, createdOn: createdOnOf(siteId, a.assetId), index });
    const target = raw.split("/").map((s) => slugify(s)).filter(Boolean).join("/");
    if (!target || target === a.folderPath.split("/").map((p) => slugify(p)).join("/")) continue;
    const change: PlannedChange = { assetId: a.assetId, before: a.folderPath || "(root)", after: target, applied: false };
    if (!req.dryRun) {
      try {
        const folderId = await ensureFolderPath(siteId, target, true);
        await getClient(siteId).updateAsset(a.assetId, { parentFolder: folderId });
        db.run(`UPDATE assets SET folder_id = ? WHERE site_id = ? AND asset_id = ?`, [folderId, siteId, a.assetId]);
        change.after = pathOfFolder(siteId, folderId) || target;
        change.applied = true;
      } catch (err) {
        change.error = err instanceof Error ? err.message : String(err);
      }
    }
    logOp(siteId, "move", a.assetId, change.before, change.after, req.dryRun);
    changes.push(change);
  }
  return changes;
}

function createdOnOf(siteId: string, assetId: string): string {
  return db.get<{ created_on: string }>(`SELECT created_on FROM assets WHERE site_id = ? AND asset_id = ?`, [siteId, assetId])?.created_on ?? "";
}
