-- asset-optimizer-webflow: local persistence schema (SQLite dialect; see server/db.ts adapter)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  site_id           TEXT PRIMARY KEY,
  access_token_enc  TEXT NOT NULL,               -- AES-256-GCM, see services/token-store.ts
  refresh_token_enc TEXT,
  scopes            TEXT NOT NULL,
  admin_token_hash  TEXT NOT NULL DEFAULT '',    -- sha256 of the App Panel admin token
  installed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_registrations (
  site_id            TEXT NOT NULL,
  trigger_type       TEXT NOT NULL,
  webflow_webhook_id TEXT NOT NULL,
  PRIMARY KEY (site_id, trigger_type)
);

CREATE TABLE IF NOT EXISTS site_settings (
  site_id              TEXT PRIMARY KEY,
  max_bytes            INTEGER NOT NULL DEFAULT 500000 CHECK (max_bytes > 0),
  modern_formats       TEXT NOT NULL DEFAULT 'image/webp,image/avif,image/svg+xml',
  target_format        TEXT NOT NULL DEFAULT 'image/webp',
  quality              INTEGER NOT NULL DEFAULT 80 CHECK (quality BETWEEN 1 AND 100),
  min_savings_pct      INTEGER NOT NULL DEFAULT 10 CHECK (min_savings_pct BETWEEN 0 AND 100),
  naming_template      TEXT NOT NULL DEFAULT '{slug}',
  folder_template      TEXT NOT NULL DEFAULT '{type}/{year}',
  archive_folder_name  TEXT NOT NULL DEFAULT '_originals',
  dry_run              INTEGER NOT NULL DEFAULT 1 CHECK (dry_run IN (0,1)),
  last_asset_sync      TEXT,
  last_reference_scan  TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  site_id   TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  parent_id TEXT,
  PRIMARY KEY (site_id, folder_id)
);

CREATE TABLE IF NOT EXISTS assets (
  site_id            TEXT NOT NULL,
  asset_id           TEXT NOT NULL,
  display_name       TEXT NOT NULL DEFAULT '',
  original_file_name TEXT NOT NULL DEFAULT '',
  mime_type          TEXT NOT NULL DEFAULT '',
  size_bytes         INTEGER NOT NULL DEFAULT 0,
  width              INTEGER,
  height             INTEGER,
  hosted_url         TEXT NOT NULL DEFAULT '',
  folder_id          TEXT,
  alt_text           TEXT NOT NULL DEFAULT '',
  content_hash       TEXT,                        -- MD5 hex (matches Webflow's fileHash)
  archived           INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_on         TEXT NOT NULL DEFAULT '',
  last_updated       TEXT NOT NULL DEFAULT '',
  synced_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (site_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets (site_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets (site_id, folder_id);

CREATE TABLE IF NOT EXISTS asset_references (
  site_id   TEXT NOT NULL,
  asset_id  TEXT NOT NULL,
  ref_type  TEXT NOT NULL CHECK (ref_type IN ('page','cms')),
  ref_id    TEXT NOT NULL,                        -- page id, or "collectionId/itemId" for CMS
  location  TEXT NOT NULL DEFAULT '',             -- CMS field slug or page title
  PRIMARY KEY (site_id, asset_id, ref_type, ref_id, location)
);
CREATE INDEX IF NOT EXISTS idx_refs_asset ON asset_references (site_id, asset_id);

CREATE TABLE IF NOT EXISTS audit_findings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('oversized','legacy_format','missing_alt','duplicate','unused')),
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_findings_site ON audit_findings (site_id, kind);

CREATE TABLE IF NOT EXISTS alt_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  suggestion  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alt_site ON alt_suggestions (site_id, status);

CREATE TABLE IF NOT EXISTS optimization_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        TEXT NOT NULL,
  asset_id       TEXT NOT NULL,
  new_asset_id   TEXT,
  folder_id      TEXT,                            -- folder of the original at job time (for per-folder reports)
  status         TEXT NOT NULL CHECK (status IN ('planned','running','completed','skipped','failed')),
  original_bytes INTEGER NOT NULL DEFAULT 0,
  new_bytes      INTEGER,
  target_format  TEXT NOT NULL DEFAULT '',
  dry_run        INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_site ON optimization_jobs (site_id, status);

CREATE TABLE IF NOT EXISTS operations_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                       -- rename | move | alt_text | optimize
  asset_id   TEXT NOT NULL,
  before_val TEXT NOT NULL DEFAULT '',
  after_val  TEXT NOT NULL DEFAULT '',
  dry_run    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_site ON operations_log (site_id, id);
