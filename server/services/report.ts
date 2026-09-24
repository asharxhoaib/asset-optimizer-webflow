import { SavingsReport, SavingsRow } from "../../shared/types";
import { db } from "../db";
import { folderPaths } from "./asset-sync";

/** Savings from completed (non-dry-run) optimization jobs, overall and per original folder. */
export function buildSavingsReport(siteId: string): SavingsReport {
  const rows = db.all<{ folder_id: string | null; jobs: number; orig: number; next: number }>(
    `SELECT folder_id, COUNT(*) AS jobs, SUM(original_bytes) AS orig, SUM(COALESCE(new_bytes, original_bytes)) AS next
       FROM optimization_jobs WHERE site_id = ? AND status = 'completed' AND dry_run = 0 GROUP BY folder_id`,
    [siteId]
  );
  const paths = folderPaths(siteId);
  const perFolder: SavingsRow[] = rows
    .map((r) => ({
      folderId: r.folder_id,
      folderPath: r.folder_id ? paths.get(r.folder_id) ?? "(deleted folder)" : "(root)",
      jobs: r.jobs,
      originalBytes: r.orig,
      newBytes: r.next,
      savedBytes: r.orig - r.next,
    }))
    .sort((a, b) => b.savedBytes - a.savedBytes);
  const originalBytes = perFolder.reduce((s, r) => s + r.originalBytes, 0);
  const newBytes = perFolder.reduce((s, r) => s + r.newBytes, 0);
  return {
    totalJobs: perFolder.reduce((s, r) => s + r.jobs, 0),
    originalBytes,
    newBytes,
    savedBytes: originalBytes - newBytes,
    savedPct: originalBytes > 0 ? Math.round(((originalBytes - newBytes) / originalBytes) * 1000) / 10 : 0,
    perFolder,
  };
}

function csvCell(v: string | number): string {
  const s = String(v);
  // Neutralize spreadsheet formula injection from user-controlled folder names.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function savingsCsv(report: SavingsReport): string {
  const lines = [["folder", "jobs", "original_bytes", "new_bytes", "saved_bytes"].join(",")];
  for (const r of report.perFolder) lines.push([r.folderPath, r.jobs, r.originalBytes, r.newBytes, r.savedBytes].map(csvCell).join(","));
  lines.push(["TOTAL", report.totalJobs, report.originalBytes, report.newBytes, report.savedBytes].map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}
