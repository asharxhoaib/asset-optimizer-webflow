import { Router } from "express";
import { db } from "../db";
import { config } from "../config";
import { WebflowWebhookEnvelope } from "../../shared/webflow-types";
import { asyncHandler } from "../services/errors";
import { syncAssets } from "../services/asset-sync";
import { purgeInstallation } from "../services/install";
import { verifyWebflowSignature } from "../services/webhook-verify";

// Mounted behind express.raw() in index.ts so signatures are checked against the exact bytes received.
const router = Router();

router.post("/:siteId/:event", asyncHandler(async (req, res) => {
  const { siteId, event } = req.params;
  const raw = req.body as Buffer;
  if (!verifyWebflowSignature(raw, req.header("x-webflow-signature"), req.header("x-webflow-timestamp"), config.webflow.clientSecret)) {
    return void res.status(401).json({ error: "Invalid signature" });
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as WebflowWebhookEnvelope;
    if (!parsed || typeof parsed !== "object") throw new Error("bad envelope");
  } catch {
    return void res.status(400).json({ error: "Invalid JSON" });
  }
  if (event === "app-uninstalled") {
    purgeInstallation(siteId);
    return void res.json({ ok: true });
  }
  if (!db.get(`SELECT 1 AS x FROM installations WHERE site_id = ?`, [siteId])) return void res.status(202).json({ ok: true, ignored: "site not installed" });
  if (event === "site-publish") {
    // Refresh the local inventory after a publish; respond immediately so Webflow does not retry.
    syncAssets(siteId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[webhook] resync failed for ${siteId}:`, err);
    });
    return void res.json({ ok: true });
  }
  res.status(404).json({ error: "Unknown event" });
}));

export default router;
