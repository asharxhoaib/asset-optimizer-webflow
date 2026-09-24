# asset-optimizer-webflow

A Webflow App that audits and optimizes site assets (images) and manages alt text. It mirrors the asset library locally, flags oversized / legacy-format / alt-less / duplicate / unused assets, runs a reviewer-approved alt-text workflow, re-encodes images through a pluggable encoder and re-points CMS references, bulk-renames and reorganizes assets, and reports bytes saved with CSV export. Every write path supports dry-run.

Stack: Node.js 20, TypeScript, Express, better-sqlite3 behind a `DbAdapter`, hand-rolled Webflow Data API v2 client (no SDK), vanilla TypeScript Designer Extension bundled with esbuild.

## Layout

```
server/                       Express app
  routes/                     oauth, webhooks, assets (sync/audit/alt text), operations (settings/optimize/organize/report)
  services/webflow-client.ts  typed fetch wrapper: token bucket, refresh-on-401, 429 backoff, presigned upload
  services/asset-sync.ts      folders + assets mirror, hash/dimension enrichment
  services/references.ts      page + CMS reference scan, reference re-pointing helper
  services/audit.ts           audit engine
  services/alt-text.ts        provider adapter (mock deterministic + HTTP), approve/reject write-back
  services/encoder.ts         encoder adapter (passthrough + HTTP)
  services/optimizer.ts       download -> encode -> upload -> verify -> re-point -> archive
  services/organize.ts        bulk rename + folder organization by templates
  services/report.ts          savings report + CSV
  services/token-store.ts     encrypted token storage interface (AES-256-GCM)
designer-extension/           App Panel (src/panel.ts, index.html, panel.css, esbuild.config.mjs, webflow.json)
shared/                       types.ts (DTOs), webflow-types.ts (API models)
db/schema.sql                 SQLite-shaped schema
```

## OAuth scopes

| Scope | Why |
| --- | --- |
| `assets:read` | List assets and asset folders, read a single asset |
| `assets:write` | Update alt text / display name / folder, create folders, request uploads |
| `sites:read` | Resolve authorized sites, register webhooks, list pages |
| `cms:read` | List collections and items to find asset references |

Optional extras (add to `WEBFLOW_SCOPES` when needed): `cms:write` to let the optimizer re-point CMS references (without it, optimizing a referenced asset fails safely and keeps the original), and `pages:read` to include page DOMs in the reference scan (without it the scan warns that page references are missing).

Install flow: `GET /oauth/authorize` (random `state`) -> Webflow -> `GET /oauth/callback` exchanges the code, stores tokens encrypted through the `TokenStore` interface, registers webhooks, runs the first asset sync and redirects to the App Panel with the site id and an admin token in the URL fragment (only its SHA-256 is stored). On `app_uninstalled` every stored token, setting and row for the site is purged.

## Data API endpoints used

| Purpose | Request |
| --- | --- |
| List assets | `GET /v2/sites/{siteId}/assets?limit=100&offset=0` |
| Get asset | `GET /v2/assets/{assetId}` |
| Update asset | `PATCH /v2/assets/{assetId}` body `{"altText":"...","displayName":"...","parentFolder":"..."}` |
| Start upload | `POST /v2/sites/{siteId}/assets` body `{"fileName":"hero.webp","fileHash":"<md5>","parentFolder":"..."}` |
| Upload bytes | presigned `uploadUrl` from the previous response (multipart POST with `uploadDetails` fields, or PUT when none) |
| Delete asset (failed-upload cleanup) | `DELETE /v2/assets/{assetId}` |
| List / create folders | `GET` / `POST /v2/sites/{siteId}/asset_folders` |
| Collections and items | `GET /v2/sites/{siteId}/collections`, `GET /v2/collections/{id}/items`, `PATCH /v2/collections/{id}/items/{itemId}` |
| Pages | `GET /v2/sites/{siteId}/pages`, `GET /v2/pages/{pageId}/dom` |
| Webhooks | `GET` / `POST /v2/sites/{siteId}/webhooks`, `DELETE /v2/webhooks/{id}` |

Example:

```
curl -X PATCH https://api.webflow.com/v2/assets/ASSET_ID \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"altText":"Team photo at the 2025 offsite","displayName":"team-offsite-2025.webp"}'
```

## Local App Panel API

All `/api` routes require `X-Site-Id` and `X-Admin-Token`. Highlights: `POST /api/sync`, `POST /api/sync/references`, `POST /api/sync/hashes`, `POST /api/audit/run`, `POST /api/alt-text/suggest`, `POST /api/alt-text/:id/approve`, `POST /api/optimize`, `POST /api/organize/rename`, `POST /api/organize/folders`, `GET /api/report`, `GET /api/report.csv`. Write endpoints accept `"dryRun": true|false`; when omitted the site setting (default: on) applies.

## Audit engine

Findings: `oversized` (above `max_bytes`), `legacy_format` (JPEG/PNG/GIF/BMP/TIFF not in the modern list), `missing_alt` (images only), `duplicate` (identical MD5 content hash; the oldest asset is the keeper), `unused` (no page or CMS references after a reference scan). Duplicate detection needs hashes: use "Fetch hashes and sizes" (downloads assets, computes MD5 and image dimensions).

## Optimization pipeline

1. Download the original. 2. Re-encode through the `ImageEncoder` adapter (`ENCODER_HTTP_URL` posts bytes with `X-Target-Format` and `X-Quality` and expects bytes back; the default passthrough encoder yields no savings). 3. Request an upload URL, send the bytes to the presigned URL, get the new asset id. 4. Verify (size matches, downloaded bytes hash equal). 5. Re-point CMS items (image fields by `fileId`, rich text/URLs by string replacement). 6. Move the original into the archive folder (`_originals` by default) only if verification and every re-point succeeded and no page references remain (pages cannot be re-pointed through the API, so those originals are kept). Assets that save less than `min_savings_pct` are skipped.

## Rate-limit strategy

Every request passes a per-site token bucket (capacity 60, refilling 60 per minute, matching Webflow's 60 requests/minute limit). A 429 blocks the whole bucket for `max(exponential backoff 1s,2s,4s..., Retry-After)` plus jitter and retries up to 5 times. A 401 triggers one refresh-token exchange and a retry. GETs retry twice on 5xx. Bulk operations are sequential so they naturally queue behind the limiter.

## Local development

```
cp .env.example .env        # fill WEBFLOW_CLIENT_ID / WEBFLOW_CLIENT_SECRET, set TOKEN_ENCRYPTION_KEY
npm install
npm run build:extension     # bundles the App Panel into designer-extension/dist
npm run dev                 # http://localhost:3000
```

Webflow must reach your machine for OAuth redirects and webhooks. Expose port 3000 with a tunnel such as ngrok (start it yourself, for example `ngrok http 3000`), then set `APP_PUBLIC_URL` and `WEBFLOW_REDIRECT_URI` (`https://<id>.ngrok.app/oauth/callback`) in `.env` and in the Webflow app settings. Webhook signatures are verified with the app client secret over `timestamp:body`.

## Environment variables

See `.env.example`: OAuth credentials and scopes, `APP_PUBLIC_URL`, `TOKEN_ENCRYPTION_KEY`, `ALT_TEXT_PROVIDER` (`mock` or `http`) with `ALT_TEXT_HTTP_URL`/`ALT_TEXT_HTTP_KEY`, `ENCODER_HTTP_URL`/`ENCODER_HTTP_KEY`, `MAX_DOWNLOAD_MB`, `DATABASE_PATH`, `PORT`.

## Swapping the database

Services only use the `DbAdapter` interface in `server/db.ts`; implement it for another driver and adapt the `datetime('now')` defaults in `db/schema.sql`.
