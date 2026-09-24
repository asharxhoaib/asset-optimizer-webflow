import crypto from "crypto";
import { AssetDto, FolderDto } from "../../shared/types";
import { WebflowAsset } from "../../shared/webflow-types";
import { config } from "../config";
import { db } from "../db";
import { HttpError } from "./errors";
import { probeDimensions } from "./image-probe";
import { stampSetting } from "./settings";
import { getClient } from "./webflow-client";

export interface SyncResult {
  assets: number;
  folders: number;
  removed: number;
}

/** Pulls folders then assets from Webflow and mirrors them locally, keeping locally derived hash/dimensions. */
export async function syncAssets(siteId: string): Promise<SyncResult> {
  const client = getClient(siteId);
  const [folders, assets] = await Promise.all([client.listAssetFolders(), client.listAssets()]);

  let removed = 0;
  db.transaction(() => {
    db.run(`DELETE FROM folders WHERE site_id = ?`, [siteId]);
    for (const f of folders) {
      db.run(`INSERT INTO folders (site_id, folder_id, name, parent_id) VALUES (?, ?, ?, ?)`, [siteId, f.id, f.displayName, f.parentFolder ?? null]);
    }
    const remoteIds = new Set(assets.map((a) => a.id));
    for (const a of assets) upsertAsset(siteId, a);
    const local = db.all<{ asset_id: string }>(`SELECT asset_id FROM assets WHERE site_id = ?`, [siteId]);
    for (const row of local) if (!remoteIds.has(row.asset_id)) {
      db.run(`DELETE FROM assets WHERE site_id = ? AND asset_id = ?`, [siteId, row.asset_id]);
      removed++;
    }
  });
  // Folder assignments may also arrive via the folder's `assets` list when the asset omits parentFolder.
  for (const f of folders) {
    for (const id of f.assets ?? []) db.run(`UPDATE assets SET folder_id = ? WHERE site_id = ? AND asset_id = ? AND folder_id IS NULL`, [f.id, siteId, id]);
  }
  stampSetting(siteId, "last_asset_sync");
  return { assets: assets.length, folders: folders.length, removed };
}

export function upsertAsset(siteId: string, a: WebflowAsset): void {
  db.run(
    `INSERT INTO assets (site_id, asset_id, display_name, original_file_name, mime_type, size_bytes, width, height, hosted_url, folder_id, alt_text, content_hash, created_on, last_updated, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(site_id, asset_id) DO UPDATE SET
       display_name = excluded.display_name, original_file_name = excluded.original_file_name, mime_type = excluded.mime_type,
       size_bytes = excluded.size_bytes, width = COALESCE(excluded.width, assets.width), height = COALESCE(excluded.height, assets.height),
       hosted_url = excluded.hosted_url, folder_id = excluded.folder_id, alt_text = excluded.alt_text,
       content_hash = COALESCE(excluded.content_hash, assets.content_hash), created_on = excluded.created_on,
       last_updated = excluded.last_updated, synced_at = datetime('now')`,
    [
      siteId,
      a.id,
      a.displayName ?? a.originalFileName ?? "",
      a.originalFileName ?? a.displayName ?? "",
      a.contentType ?? "",
      a.size ?? 0,
      a.width ?? null,
      a.height ?? null,
      a.hostedUrl ?? "",
      a.parentFolder ?? null,
      a.altText ?? "",
      a.fileHash ?? null,
      a.createdOn ?? "",
      a.lastUpdated ?? "",
    ]
  );
}

export function folderPaths(siteId: string): Map<string, string> {
  const rows = db.all<{ folder_id: string; name: string; parent_id: string | null }>(`SELECT folder_id, name, parent_id FROM folders WHERE site_id = ?`, [siteId]);
  const byId = new Map(rows.map((r) => [r.folder_id, r]));
  const out = new Map<string, string>();
  for (const r of rows) {
    const parts: string[] = [];
    let cur: typeof r | undefined = r;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.folder_id)) {
      seen.add(cur.folder_id);
      parts.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    out.set(r.folder_id, parts.join("/"));
  }
  return out;
}

export function listFolders(siteId: string): FolderDto[] {
  const paths = folderPaths(siteId);
  return db
    .all<{ folderId: string; name: string; parentId: string | null }>(`SELECT folder_id AS folderId, name, parent_id AS parentId FROM folders WHERE site_id = ?`, [siteId])
    .map((f) => ({ ...f, path: paths.get(f.folderId) ?? f.name }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface AssetQuery {
  folderId?: string;
  altStatus?: string;
  q?: string;
  includeArchived?: boolean;
}

export function listAssets(siteId: string, query: AssetQuery = {}): AssetDto[] {
  const where = [`a.site_id = ?`];
  const params: Array<string | number> = [siteId];
  if (!query.includeArchived) where.push(`a.archived = 0`);
  if (query.folderId) {
    where.push(`a.folder_id = ?`);
    params.push(query.folderId);
  }
  if (query.q) {
    where.push(`(a.display_name LIKE ? OR a.original_file_name LIKE ?)`);
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  const rows = db.all<Omit<AssetDto, "folderPath">>(
    `SELECT a.asset_id AS assetId, a.display_name AS displayName, a.original_file_name AS originalFileName, a.mime_type AS mimeType,
            a.size_bytes AS sizeBytes, a.width AS width, a.height AS height, a.hosted_url AS hostedUrl, a.folder_id AS folderId,
            a.alt_text AS altText, a.content_hash AS contentHash, a.archived AS archived,
            CASE WHEN a.alt_text <> '' THEN 'present'
                 WHEN EXISTS (SELECT 1 FROM alt_suggestions s WHERE s.site_id = a.site_id AND s.asset_id = a.asset_id AND s.status = 'pending') THEN 'suggested'
                 ELSE 'missing' END AS altStatus,
            (SELECT COUNT(*) FROM asset_references r WHERE r.site_id = a.site_id AND r.asset_id = a.asset_id) AS refCount
       FROM assets a WHERE ${where.join(" AND ")} ORDER BY a.size_bytes DESC`,
    params
  );
  const paths = folderPaths(siteId);
  const list = rows.map((r) => ({ ...r, folderPath: r.folderId ? paths.get(r.folderId) ?? "" : "" }));
  return query.altStatus ? list.filter((a) => a.altStatus === query.altStatus) : list;
}

export function getAssetRow(siteId: string, assetId: string): AssetDto {
  const found = listAssets(siteId, { includeArchived: true }).find((a) => a.assetId === assetId);
  if (!found) throw new HttpError(404, `Asset ${assetId} not found; run a sync first`);
  return found;
}

export async function downloadAsset(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > config.maxDownloadBytes) throw new Error(`Asset exceeds MAX_DOWNLOAD_MB (${declared} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > config.maxDownloadBytes) throw new Error(`Asset exceeds MAX_DOWNLOAD_MB (${buf.length} bytes)`);
  return buf;
}

export function md5Hex(buf: Buffer): string {
  return crypto.createHash("md5").update(buf).digest("hex");
}

export interface EnrichResult {
  examined: number;
  updated: number;
  failed: number;
}

/** Downloads assets that lack a content hash or dimensions and fills both in (needed for duplicate detection). */
export async function enrichAssets(siteId: string, limit = 50): Promise<EnrichResult> {
  const rows = db.all<{ asset_id: string; hosted_url: string; mime_type: string }>(
    `SELECT asset_id, hosted_url, mime_type FROM assets
      WHERE site_id = ? AND archived = 0 AND hosted_url <> '' AND (content_hash IS NULL OR (width IS NULL AND mime_type LIKE 'image/%'))
      ORDER BY size_bytes ASC LIMIT ?`,
    [siteId, limit]
  );
  const result: EnrichResult = { examined: rows.length, updated: 0, failed: 0 };
  for (const r of rows) {
    try {
      const buf = await downloadAsset(r.hosted_url);
      const dims = probeDimensions(buf);
      db.run(`UPDATE assets SET content_hash = ?, width = COALESCE(?, width), height = COALESCE(?, height) WHERE site_id = ? AND asset_id = ?`, [
        md5Hex(buf),
        dims?.width ?? null,
        dims?.height ?? null,
        siteId,
        r.asset_id,
      ]);
      result.updated++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
