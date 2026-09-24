import { SettingsDto } from "../../shared/types";
import { db } from "../db";
import { HttpError } from "./errors";

interface SettingsRow {
  max_bytes: number;
  modern_formats: string;
  target_format: string;
  quality: number;
  min_savings_pct: number;
  naming_template: string;
  folder_template: string;
  archive_folder_name: string;
  dry_run: number;
  last_asset_sync: string | null;
  last_reference_scan: string | null;
}

export function getSettings(siteId: string): SettingsDto {
  db.run(`INSERT OR IGNORE INTO site_settings (site_id) VALUES (?)`, [siteId]);
  const r = db.get<SettingsRow>(`SELECT * FROM site_settings WHERE site_id = ?`, [siteId]) as SettingsRow;
  return {
    maxBytes: r.max_bytes,
    modernFormats: r.modern_formats,
    targetFormat: r.target_format,
    quality: r.quality,
    minSavingsPct: r.min_savings_pct,
    namingTemplate: r.naming_template,
    folderTemplate: r.folder_template,
    archiveFolderName: r.archive_folder_name,
    dryRun: r.dry_run === 1,
    lastAssetSync: r.last_asset_sync,
    lastReferenceScan: r.last_reference_scan,
  };
}

function intIn(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  return v;
}

function text(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `${name} must be a non-empty string`);
  return v.trim();
}

export function updateSettings(siteId: string, patch: Record<string, unknown>): SettingsDto {
  getSettings(siteId);
  const sets: string[] = [];
  const params: Array<string | number> = [];
  const add = (col: string, val: string | number) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };
  if (patch.maxBytes !== undefined) add("max_bytes", intIn(patch.maxBytes, "maxBytes", 1, 1_000_000_000));
  if (patch.modernFormats !== undefined) add("modern_formats", text(patch.modernFormats, "modernFormats"));
  if (patch.targetFormat !== undefined) add("target_format", text(patch.targetFormat, "targetFormat"));
  if (patch.quality !== undefined) add("quality", intIn(patch.quality, "quality", 1, 100));
  if (patch.minSavingsPct !== undefined) add("min_savings_pct", intIn(patch.minSavingsPct, "minSavingsPct", 0, 100));
  if (patch.namingTemplate !== undefined) add("naming_template", text(patch.namingTemplate, "namingTemplate"));
  if (patch.folderTemplate !== undefined) add("folder_template", text(patch.folderTemplate, "folderTemplate"));
  if (patch.archiveFolderName !== undefined) add("archive_folder_name", text(patch.archiveFolderName, "archiveFolderName"));
  if (patch.dryRun !== undefined) {
    if (typeof patch.dryRun !== "boolean") throw new HttpError(400, "dryRun must be a boolean");
    add("dry_run", patch.dryRun ? 1 : 0);
  }
  if (sets.length > 0) {
    sets.push(`updated_at = datetime('now')`);
    db.run(`UPDATE site_settings SET ${sets.join(", ")} WHERE site_id = ?`, [...params, siteId]);
  }
  return getSettings(siteId);
}

/** Resolves the effective dry-run flag: an explicit per-request boolean wins over the site default. */
export function effectiveDryRun(siteId: string, requested: unknown): boolean {
  return typeof requested === "boolean" ? requested : getSettings(siteId).dryRun;
}

export function stampSetting(siteId: string, column: "last_asset_sync" | "last_reference_scan"): void {
  getSettings(siteId);
  db.run(`UPDATE site_settings SET ${column} = datetime('now') WHERE site_id = ?`, [siteId]);
}
