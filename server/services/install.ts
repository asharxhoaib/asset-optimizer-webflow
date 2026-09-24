import { config } from "../config";
import { db } from "../db";
import { hashToken, newAdminToken } from "./auth";
import { syncAssets } from "./asset-sync";
import { exchangeCode, listAuthorizedSites } from "./oauth-service";
import { getSettings } from "./settings";
import { tokenStore } from "./token-store";
import { forgetClient, getClient } from "./webflow-client";

export const WEBHOOK_TRIGGERS = [
  { triggerType: "site_publish", path: "site-publish" },
  { triggerType: "app_uninstalled", path: "app-uninstalled" },
] as const;

export function webhookUrl(siteId: string, path: string): string {
  return `${config.publicUrl}/webhooks/${encodeURIComponent(siteId)}/${path}`;
}

/** Registers (or re-registers) our webhooks for a site, removing stale registrations first. */
export async function registerWebhooks(siteId: string): Promise<void> {
  const client = getClient(siteId);
  const existing = await client.listWebhooks();
  for (const hook of existing) {
    if (hook.url.startsWith(`${config.publicUrl}/webhooks/`)) {
      try {
        await client.deleteWebhook(hook.id);
      } catch {
        // Already removed.
      }
    }
  }
  db.run(`DELETE FROM webhook_registrations WHERE site_id = ?`, [siteId]);
  for (const t of WEBHOOK_TRIGGERS) {
    try {
      const created = await client.createWebhook(t.triggerType, webhookUrl(siteId, t.path));
      db.run(`INSERT OR REPLACE INTO webhook_registrations (site_id, trigger_type, webflow_webhook_id) VALUES (?, ?, ?)`, [siteId, t.triggerType, created.id]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[install] webhook ${t.triggerType} registration failed for ${siteId}:`, err);
    }
  }
}

export interface InstallResult {
  siteId: string;
  adminToken: string;
}

/** OAuth callback body: exchange the code, store encrypted tokens, register webhooks, run the first asset sync. */
export async function completeInstall(code: string): Promise<InstallResult[]> {
  const token = await exchangeCode(code);
  const sites = await listAuthorizedSites(token.access_token);
  if (sites.length === 0) throw new Error("No sites were authorized for this installation");

  const results: InstallResult[] = [];
  for (const site of sites) {
    tokenStore.save(site.id, { accessToken: token.access_token, refreshToken: token.refresh_token ?? null, scopes: token.scope ?? config.webflow.scopes.join(",") });
    const adminToken = newAdminToken();
    db.run(`UPDATE installations SET admin_token_hash = ? WHERE site_id = ?`, [hashToken(adminToken), site.id]);
    getSettings(site.id);
    await registerWebhooks(site.id);
    try {
      await syncAssets(site.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[install] initial asset sync failed for ${site.id}:`, err);
    }
    results.push({ siteId: site.id, adminToken });
  }
  return results;
}

/** app-uninstalled cleanup: purge tokens, config and every locally stored row for the site. */
export function purgeInstallation(siteId: string): void {
  db.transaction(() => {
    for (const table of ["site_settings", "folders", "assets", "asset_references", "audit_findings", "alt_suggestions", "optimization_jobs", "operations_log", "webhook_registrations"]) {
      db.run(`DELETE FROM ${table} WHERE site_id = ?`, [siteId]);
    }
  });
  tokenStore.purge(siteId);
  forgetClient(siteId);
}
