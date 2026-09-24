import { JobDto } from "../../shared/types";
import { db } from "../db";
import { downloadAsset, getAssetRow, md5Hex, upsertAsset } from "./asset-sync";
import { EXTENSIONS, getEncoder } from "./encoder";
import { ensureFolderPath } from "./folders";
import { probeDimensions } from "./image-probe";
import { logOp } from "./oplog";
import { replaceAssetRefs } from "./references";
import { getSettings } from "./settings";
import { splitFileName } from "./naming";
import { getClient } from "./webflow-client";

export interface OptimizeOptions {
  dryRun: boolean;
  quality?: number;
  targetFormat?: string;
  minSavingsPct?: number;
}

interface JobInit {
  siteId: string;
  assetId: string;
  folderId: string | null;
  status: JobDto["status"];
  originalBytes: number;
  targetFormat: string;
  dryRun: boolean;
  note: string;
}

function createJob(j: JobInit): number {
  return Number(
    db.run(
      `INSERT INTO optimization_jobs (site_id, asset_id, folder_id, status, original_bytes, target_format, dry_run, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [j.siteId, j.assetId, j.folderId, j.status, j.originalBytes, j.targetFormat, j.dryRun ? 1 : 0, j.note]
    ).lastInsertRowid
  );
}

function finishJob(id: number, status: JobDto["status"], note: string, newBytes: number | null, newAssetId: string | null): void {
  db.run(`UPDATE optimization_jobs SET status = ?, note = ?, new_bytes = ?, new_asset_id = ?, completed_at = datetime('now') WHERE id = ?`, [status, note, newBytes, newAssetId, id]);
}

export function getJob(siteId: string, id: number): JobDto {
  return db.get<JobDto>(`${JOB_SELECT} WHERE j.site_id = ? AND j.id = ?`, [siteId, id]) as JobDto;
}

const JOB_SELECT = `SELECT j.id AS id, j.asset_id AS assetId, COALESCE(a.display_name, j.asset_id) AS displayName, j.new_asset_id AS newAssetId, j.status AS status,
       j.original_bytes AS originalBytes, j.new_bytes AS newBytes, j.target_format AS targetFormat, j.dry_run AS dryRun, j.note AS note, j.created_at AS createdAt
  FROM optimization_jobs j LEFT JOIN assets a ON a.site_id = j.site_id AND a.asset_id = j.asset_id`;

export function listJobs(siteId: string, limit = 200): JobDto[] {
  return db.all<JobDto>(`${JOB_SELECT} WHERE j.site_id = ? ORDER BY j.id DESC LIMIT ?`, [siteId, limit]);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the optimization pipeline for each asset:
 * download -> re-encode (encoder adapter) -> presigned upload (request URL -> upload bytes -> asset id) -> verify
 * -> re-point CMS references -> archive original. The original is only archived once the new asset is verified and
 * every CMS reference has been re-pointed. Dry runs record a planned job and write nothing.
 */
export async function optimizeAssets(siteId: string, assetIds: string[], opts: OptimizeOptions): Promise<JobDto[]> {
  const out: JobDto[] = [];
  for (const id of assetIds) {
    const jobId = await optimizeOne(siteId, id, opts);
    out.push(getJob(siteId, jobId));
  }
  return out;
}

async function optimizeOne(siteId: string, assetId: string, opts: OptimizeOptions): Promise<number> {
  const settings = getSettings(siteId);
  const quality = opts.quality ?? settings.quality;
  const targetFormat = opts.targetFormat ?? settings.targetFormat;
  const minSavings = opts.minSavingsPct ?? settings.minSavingsPct;
  const asset = getAssetRow(siteId, assetId);
  const base = { siteId, assetId, folderId: asset.folderId, originalBytes: asset.sizeBytes, targetFormat, dryRun: opts.dryRun };

  if (asset.archived) return createJob({ ...base, status: "skipped", note: "Asset is archived" });
  if (!asset.mimeType.startsWith("image/")) return createJob({ ...base, status: "skipped", note: "Not an image" });
  if (asset.mimeType === "image/svg+xml") return createJob({ ...base, status: "skipped", note: "SVG is already vector" });
  if (asset.mimeType === targetFormat) return createJob({ ...base, status: "skipped", note: `Already ${targetFormat}` });
  const targetExt = EXTENSIONS[targetFormat];
  if (!targetExt) return createJob({ ...base, status: "skipped", note: `Unsupported target format ${targetFormat}` });

  const cmsRefs = db.all<{ ref_id: string; location: string }>(`SELECT ref_id, location FROM asset_references WHERE site_id = ? AND asset_id = ? AND ref_type = 'cms'`, [siteId, assetId]);
  const pageRefs = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM asset_references WHERE site_id = ? AND asset_id = ? AND ref_type = 'page'`, [siteId, assetId])?.n ?? 0;

  if (opts.dryRun) {
    const steps = [
      `download ${asset.hostedUrl}`,
      `re-encode ${asset.mimeType} -> ${targetFormat} at quality ${quality} (${getEncoder().name} encoder)`,
      `upload via presigned URL and verify`,
      `re-point ${new Set(cmsRefs.map((r) => r.ref_id)).size} CMS item(s)`,
      pageRefs > 0 ? `keep original (${pageRefs} page reference(s) cannot be re-pointed via the API)` : `archive original into ${settings.archiveFolderName}`,
    ];
    const id = createJob({ ...base, status: "planned", note: steps.join("; ") });
    logOp(siteId, "optimize", assetId, asset.mimeType, targetFormat, true);
    return id;
  }

  const jobId = createJob({ ...base, status: "running", note: "" });
  let newAssetId: string | null = null;
  try {
    const client = getClient(siteId);
    const original = await downloadAsset(asset.hostedUrl);
    const encoded = await getEncoder().encode(original, asset.mimeType, { targetFormat, quality });
    const savedPct = (1 - encoded.data.length / original.length) * 100;
    if (savedPct < minSavings) {
      finishJob(jobId, "skipped", `Savings ${savedPct.toFixed(1)}% below the ${minSavings}% threshold`, encoded.data.length, null);
      return jobId;
    }

    const ext = EXTENSIONS[encoded.mimeType] ?? targetExt;
    const fileName = `${splitFileName(asset.originalFileName || asset.displayName).name}.${ext}`;
    const upload = await client.requestAssetUpload(fileName, md5Hex(encoded.data), asset.folderId);
    newAssetId = upload.id;
    await client.uploadToPresignedUrl(upload, encoded.data, encoded.mimeType, fileName);

    // Verify: the new asset must resolve with the expected size and be downloadable before anything is re-pointed.
    let created = await client.getAsset(newAssetId);
    for (let attempt = 0; attempt < 5 && !(created.hostedUrl ?? upload.hostedUrl ?? upload.assetUrl); attempt++) {
      await sleep(1000);
      created = await client.getAsset(newAssetId);
    }
    const newUrl = created.hostedUrl ?? upload.hostedUrl ?? upload.assetUrl ?? "";
    if (!newUrl) throw new Error("Verification failed: new asset has no hosted URL");
    if (created.size !== undefined && created.size !== encoded.data.length) throw new Error(`Verification failed: size ${created.size} != uploaded ${encoded.data.length}`);
    const check = await downloadAsset(newUrl);
    if (md5Hex(check) !== md5Hex(encoded.data)) throw new Error("Verification failed: downloaded bytes do not match the upload");

    const carry: { altText?: string; displayName?: string } = { displayName: asset.displayName ? `${splitFileName(asset.displayName).name}.${ext}` : fileName };
    if (asset.altText) carry.altText = asset.altText;
    const finalAsset = await client.updateAsset(newAssetId, carry);

    const failures: string[] = [];
    const items = new Map<string, string>();
    for (const r of cmsRefs) items.set(r.ref_id, r.ref_id);
    for (const ref of items.keys()) {
      const [collectionId, itemId] = ref.split("/");
      try {
        const item = await client.getItem(collectionId, itemId);
        const patch: Record<string, unknown> = {};
        for (const [slug, val] of Object.entries(item.fieldData ?? {})) {
          const r = replaceAssetRefs(val, assetId, asset.hostedUrl, newAssetId, newUrl);
          if (r.changed) patch[slug] = r.value;
        }
        if (Object.keys(patch).length > 0) await client.updateItem(collectionId, itemId, patch);
      } catch (err) {
        failures.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) {
      finishJob(jobId, "failed", `Original kept; CMS re-point failed (${failures.length}): ${failures.slice(0, 3).join(" | ")}`, encoded.data.length, newAssetId);
      return jobId;
    }

    let note = `Re-pointed ${items.size} CMS item(s)`;
    let archived = false;
    if (pageRefs > 0) {
      note += `; original kept because ${pageRefs} page reference(s) cannot be re-pointed via the API`;
    } else {
      const archiveFolder = await ensureFolderPath(siteId, settings.archiveFolderName, true);
      await client.updateAsset(assetId, { parentFolder: archiveFolder });
      archived = true;
      note += `; original archived into ${settings.archiveFolderName}`;
    }

    db.transaction(() => {
      upsertAsset(siteId, { ...finalAsset, id: newAssetId as string, hostedUrl: newUrl, contentType: encoded.mimeType, size: encoded.data.length, parentFolder: asset.folderId, altText: asset.altText, fileHash: md5Hex(encoded.data), createdOn: finalAsset.createdOn ?? new Date().toISOString() });
      const dims = probeDimensions(encoded.data) ?? (asset.width && asset.height ? { width: asset.width, height: asset.height } : null);
      if (dims) db.run(`UPDATE assets SET width = ?, height = ? WHERE site_id = ? AND asset_id = ?`, [dims.width, dims.height, siteId, newAssetId]);
      db.run(`UPDATE asset_references SET asset_id = ? WHERE site_id = ? AND asset_id = ? AND ref_type = 'cms'`, [newAssetId, siteId, assetId]);
      if (archived) {
        const archiveId = db.get<{ folder_id: string }>(`SELECT folder_id FROM folders WHERE site_id = ? AND name = ? AND parent_id IS NULL`, [siteId, settings.archiveFolderName]);
        db.run(`UPDATE assets SET archived = 1, folder_id = ? WHERE site_id = ? AND asset_id = ?`, [archiveId?.folder_id ?? null, siteId, assetId]);
      }
    });
    logOp(siteId, "optimize", assetId, `${asset.mimeType} ${asset.sizeBytes}B`, `${encoded.mimeType} ${encoded.data.length}B (${newAssetId})`, false);
    finishJob(jobId, "completed", note, encoded.data.length, newAssetId);
    return jobId;
  } catch (err) {
    // Roll back a half-finished upload so it does not linger as an orphan.
    if (newAssetId) {
      try {
        const stillReferenced = db.get(`SELECT 1 AS x FROM asset_references WHERE site_id = ? AND asset_id = ?`, [siteId, newAssetId]);
        if (!stillReferenced) await getClient(siteId).deleteAsset(newAssetId);
      } catch {
        // Best effort.
      }
    }
    finishJob(jobId, "failed", err instanceof Error ? err.message : String(err), null, null);
    return jobId;
  }
}
