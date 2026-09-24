import { AuditSummary, FindingDto, FindingKind } from "../../shared/types";
import { db } from "../db";
import { getSettings } from "./settings";

const LEGACY = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/bmp", "image/tiff"]);

interface AuditAsset {
  asset_id: string;
  display_name: string;
  mime_type: string;
  size_bytes: number;
  alt_text: string;
  content_hash: string | null;
  created_on: string;
  ref_count: number;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Rebuilds audit_findings for a site: oversized files, non-modern formats, missing alt text,
 * duplicate content hashes and unused assets (no page/CMS references from the last reference scan).
 */
export function runAudit(siteId: string): AuditSummary {
  const s = getSettings(siteId);
  const modern = new Set(s.modernFormats.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean));
  const assets = db.all<AuditAsset>(
    `SELECT a.asset_id, a.display_name, a.mime_type, a.size_bytes, a.alt_text, a.content_hash, a.created_on,
            (SELECT COUNT(*) FROM asset_references r WHERE r.site_id = a.site_id AND r.asset_id = a.asset_id) AS ref_count
       FROM assets a WHERE a.site_id = ? AND a.archived = 0`,
    [siteId]
  );
  const warnings: string[] = [];
  const findings: Array<{ assetId: string; kind: FindingKind; detail: string }> = [];
  const isImage = (a: AuditAsset) => a.mime_type.toLowerCase().startsWith("image/");

  for (const a of assets) {
    const mime = a.mime_type.toLowerCase();
    if (a.size_bytes > s.maxBytes) findings.push({ assetId: a.asset_id, kind: "oversized", detail: `${fmtBytes(a.size_bytes)} exceeds the ${fmtBytes(s.maxBytes)} limit` });
    if (isImage(a) && LEGACY.has(mime) && !modern.has(mime)) findings.push({ assetId: a.asset_id, kind: "legacy_format", detail: `${mime} could be served as ${s.targetFormat}` });
    if (isImage(a) && a.alt_text.trim() === "") findings.push({ assetId: a.asset_id, kind: "missing_alt", detail: "No alt text set" });
  }

  const withHash = assets.filter((a) => a.content_hash);
  if (withHash.length < assets.length) warnings.push(`${assets.length - withHash.length} asset(s) have no content hash yet; run "Fetch hashes" to include them in duplicate detection.`);
  const groups = new Map<string, AuditAsset[]>();
  for (const a of withHash) groups.set(a.content_hash as string, [...(groups.get(a.content_hash as string) ?? []), a]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((x, y) => x.created_on.localeCompare(y.created_on) || x.asset_id.localeCompare(y.asset_id));
    const keeper = group[0];
    for (const dup of group.slice(1)) findings.push({ assetId: dup.asset_id, kind: "duplicate", detail: `Identical content to ${keeper.display_name} (${keeper.asset_id})` });
  }

  if (s.lastReferenceScan) {
    for (const a of assets) if (a.ref_count === 0) findings.push({ assetId: a.asset_id, kind: "unused", detail: "No page or CMS references found" });
  } else {
    warnings.push("Reference scan has not run; unused-asset detection was skipped.");
  }

  db.transaction(() => {
    db.run(`DELETE FROM audit_findings WHERE site_id = ?`, [siteId]);
    for (const f of findings) db.run(`INSERT INTO audit_findings (site_id, asset_id, kind, detail) VALUES (?, ?, ?, ?)`, [siteId, f.assetId, f.kind, f.detail]);
  });
  return getAudit(siteId, warnings);
}

export function getAudit(siteId: string, warnings: string[] = []): AuditSummary {
  const findings = db.all<FindingDto>(
    `SELECT f.id AS id, f.asset_id AS assetId, COALESCE(a.display_name, f.asset_id) AS displayName, f.kind AS kind, f.detail AS detail
       FROM audit_findings f LEFT JOIN assets a ON a.site_id = f.site_id AND a.asset_id = f.asset_id
      WHERE f.site_id = ? ORDER BY f.kind, f.id`,
    [siteId]
  );
  const counts: Record<FindingKind, number> = { oversized: 0, legacy_format: 0, missing_alt: 0, duplicate: 0, unused: 0 };
  for (const f of findings) counts[f.kind]++;
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM assets WHERE site_id = ? AND archived = 0`, [siteId])?.n ?? 0;
  return { total, counts, warnings, findings };
}
