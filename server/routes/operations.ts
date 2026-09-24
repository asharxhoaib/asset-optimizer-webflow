import { Router } from "express";
import { siteOf } from "../services/auth";
import { asyncHandler, HttpError, idListParam } from "../services/errors";
import { listOps } from "../services/oplog";
import { listJobs, optimizeAssets } from "../services/optimizer";
import { bulkRename, organizeFolders } from "../services/organize";
import { buildSavingsReport, savingsCsv } from "../services/report";
import { effectiveDryRun, getSettings, updateSettings } from "../services/settings";

const router = Router();

router.get("/settings", (_req, res) => {
  res.json(getSettings(siteOf(res)));
});

router.put("/settings", (req, res) => {
  res.json(updateSettings(siteOf(res), (req.body ?? {}) as Record<string, unknown>));
});

router.get("/optimize/jobs", (_req, res) => {
  res.json({ jobs: listJobs(siteOf(res)) });
});

router.post("/optimize", asyncHandler(async (req, res) => {
  const siteId = siteOf(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ids = idListParam(body.assetIds, "assetIds");
  if (ids.length > 25) throw new HttpError(400, "Optimize at most 25 assets per request");
  const jobs = await optimizeAssets(siteId, ids, {
    dryRun: effectiveDryRun(siteId, body.dryRun),
    quality: typeof body.quality === "number" ? body.quality : undefined,
    targetFormat: typeof body.targetFormat === "string" ? body.targetFormat : undefined,
    minSavingsPct: typeof body.minSavingsPct === "number" ? body.minSavingsPct : undefined,
  });
  res.json({ jobs });
}));

router.post("/organize/rename", asyncHandler(async (req, res) => {
  const siteId = siteOf(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const template = typeof body.template === "string" && body.template.trim() ? body.template.trim() : getSettings(siteId).namingTemplate;
  const changes = await bulkRename(siteId, {
    template,
    folderId: typeof body.folderId === "string" ? body.folderId : undefined,
    onlyMatching: typeof body.onlyMatching === "string" && body.onlyMatching ? body.onlyMatching : undefined,
    dryRun: effectiveDryRun(siteId, body.dryRun),
  });
  res.json({ changes });
}));

router.post("/organize/folders", asyncHandler(async (req, res) => {
  const siteId = siteOf(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const template = typeof body.template === "string" && body.template.trim() ? body.template.trim() : getSettings(siteId).folderTemplate;
  const changes = await organizeFolders(siteId, {
    template,
    folderId: typeof body.folderId === "string" ? body.folderId : undefined,
    dryRun: effectiveDryRun(siteId, body.dryRun),
  });
  res.json({ changes });
}));

router.get("/report", (_req, res) => {
  res.json(buildSavingsReport(siteOf(res)));
});

router.get("/report.csv", (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="asset-savings.csv"');
  res.send(savingsCsv(buildSavingsReport(siteOf(res))));
});

router.get("/operations", (_req, res) => {
  res.json({ operations: listOps(siteOf(res)) });
});

export default router;
