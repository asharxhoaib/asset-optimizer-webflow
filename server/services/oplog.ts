import { OpLogDto } from "../../shared/types";
import { db } from "../db";

export function logOp(siteId: string, kind: string, assetId: string, before: string, after: string, dryRun: boolean): void {
  db.run(`INSERT INTO operations_log (site_id, kind, asset_id, before_val, after_val, dry_run) VALUES (?, ?, ?, ?, ?, ?)`, [siteId, kind, assetId, before, after, dryRun ? 1 : 0]);
}

export function listOps(siteId: string, limit = 200): OpLogDto[] {
  return db.all<OpLogDto>(
    `SELECT id, kind, asset_id AS assetId, before_val AS before, after_val AS after, dry_run AS dryRun, created_at AS createdAt
       FROM operations_log WHERE site_id = ? ORDER BY id DESC LIMIT ?`,
    [siteId, limit]
  );
}
