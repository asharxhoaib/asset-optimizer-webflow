import { Router } from "express";
import { enrichAssets, listAssets, listFolders, syncAssets } from "../services/asset-sync";
import { approveSuggestion, generateSuggestions, listSuggestions, rejectSuggestion } from "../services/alt-text";
import { getAudit, runAudit } from "../services/audit";
import { asyncHandler, HttpError } from "../services/errors";
import { scanReferences } from "../services/references";
import { effectiveDryRun } from "../services/settings";
import { siteOf } from "../services/auth";

const router = Router();

router.get("/assets", (req, res) => {
  const q = req.query;
  res.json({
    assets: listAssets(siteOf(res), {
      folderId: typeof q.folderId === "string" ? q.folderId : undefined,
      altStatus: typeof q.altStatus === "string" ? q.altStatus : undefined,
      q: typeof q.q === "string" ? q.q : undefined,
      includeArchived: q.includeArchived === "true",
    }),
  });
});

router.get("/folders", (_req, res) => {
  res.json({ folders: listFolders(siteOf(res)) });
});

router.post("/sync", asyncHandler(async (_req, res) => {
  res.json(await syncAssets(siteOf(res)));
}));

router.post("/sync/references", asyncHandler(async (_req, res) => {
  res.json(await scanReferences(siteOf(res)));
}));

router.post("/sync/hashes", asyncHandler(async (req, res) => {
  const limit = typeof req.body?.limit === "number" ? Math.min(200, Math.max(1, Math.floor(req.body.limit))) : 50;
  res.json(await enrichAssets(siteOf(res), limit));
}));

router.get("/audit", (_req, res) => {
  res.json(getAudit(siteOf(res)));
});

router.post("/audit/run", (_req, res) => {
  res.json(runAudit(siteOf(res)));
});

router.get("/alt-text", (req, res) => {
  res.json({ suggestions: listSuggestions(siteOf(res), typeof req.query.status === "string" ? req.query.status : undefined) });
});

router.post("/alt-text/suggest", asyncHandler(async (req, res) => {
  const ids = req.body?.assetIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((i: unknown) => typeof i !== "string"))) throw new HttpError(400, "assetIds must be an array of strings");
  res.json(await generateSuggestions(siteOf(res), ids));
}));

router.post("/alt-text/:id/approve", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, "Invalid suggestion id");
  const text = typeof req.body?.text === "string" ? req.body.text : undefined;
  res.json(await approveSuggestion(siteOf(res), id, text, effectiveDryRun(siteOf(res), req.body?.dryRun)));
}));

router.post("/alt-text/:id/reject", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, "Invalid suggestion id");
  rejectSuggestion(siteOf(res), id);
  res.json({ ok: true });
});

export default router;
