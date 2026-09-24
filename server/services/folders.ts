import { db } from "../db";
import { folderPaths } from "./asset-sync";
import { getClient } from "./webflow-client";

/**
 * Resolves a "a/b/c" folder path to a folder id, creating missing segments through
 * POST /v2/sites/{siteId}/asset_folders. Newly created folders are cached locally.
 * In dry-run mode nothing is created and null is returned for a missing path.
 */
export async function ensureFolderPath(siteId: string, path: string, create: boolean): Promise<string | null> {
  const segments = path.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  let parent: string | null = null;
  for (const seg of segments) {
    const existing: { folder_id: string } | undefined = db.get<{ folder_id: string }>(
      `SELECT folder_id FROM folders WHERE site_id = ? AND name = ? AND COALESCE(parent_id, '') = ?`,
      [siteId, seg, parent ?? ""]
    );
    if (existing) {
      parent = existing.folder_id;
      continue;
    }
    if (!create) return null;
    const created = await getClient(siteId).createAssetFolder(seg, parent);
    db.run(`INSERT OR REPLACE INTO folders (site_id, folder_id, name, parent_id) VALUES (?, ?, ?, ?)`, [siteId, created.id, seg, parent]);
    parent = created.id;
  }
  return parent;
}

export function pathOfFolder(siteId: string, folderId: string | null): string {
  return folderId ? folderPaths(siteId).get(folderId) ?? "" : "";
}
