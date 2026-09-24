import { db } from "../db";
import { stampSetting } from "./settings";
import { getClient, WebflowApiError } from "./webflow-client";

const ID_IN_URL = /(?:^|[/_-])([0-9a-f]{24})(?:_|\/|\.|$)/g;

/** Collects every Webflow asset id mentioned in a value: image field objects (fileId) and CDN URLs (…/{assetId}_name.ext). */
export function collectAssetIds(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    ID_IN_URL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ID_IN_URL.exec(value)) !== null) out.add(m[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectAssetIds(v, out);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.fileId === "string") out.add(obj.fileId);
    for (const v of Object.values(obj)) collectAssetIds(v, out);
  }
}

export interface ReferenceScanResult {
  cmsItems: number;
  pages: number;
  references: number;
  warnings: string[];
}

/**
 * Rebuilds asset_references from CMS item field data (cms:read) and page DOMs (pages:read, optional).
 * Refs are stored only for assets known locally. Pages that cannot be read produce a warning, not a failure.
 */
export async function scanReferences(siteId: string): Promise<ReferenceScanResult> {
  const client = getClient(siteId);
  const known = new Set(db.all<{ asset_id: string }>(`SELECT asset_id FROM assets WHERE site_id = ?`, [siteId]).map((r) => r.asset_id));
  const found: Array<{ assetId: string; type: "page" | "cms"; refId: string; location: string }> = [];
  const warnings: string[] = [];
  let cmsItems = 0;
  let pageCount = 0;

  for (const col of await client.listCollections()) {
    for (const item of await client.listItems(col.id)) {
      cmsItems++;
      for (const [slug, value] of Object.entries(item.fieldData ?? {})) {
        const ids = new Set<string>();
        collectAssetIds(value, ids);
        for (const id of ids) if (known.has(id)) found.push({ assetId: id, type: "cms", refId: `${col.id}/${item.id}`, location: slug });
      }
    }
  }

  try {
    for (const page of await client.listPages()) {
      const dom = await client.getPageDom(page.id);
      pageCount++;
      const ids = new Set<string>();
      collectAssetIds(dom, ids);
      for (const id of ids) if (known.has(id)) found.push({ assetId: id, type: "page", refId: page.id, location: page.title ?? page.slug ?? "" });
    }
  } catch (err) {
    if (err instanceof WebflowApiError && (err.status === 403 || err.status === 401 || err.status === 404)) {
      warnings.push("Page DOMs could not be read (grant the optional pages:read scope); page references are missing, so 'unused' results may over-report.");
    } else {
      throw err;
    }
  }

  db.transaction(() => {
    db.run(`DELETE FROM asset_references WHERE site_id = ?`, [siteId]);
    for (const f of found) {
      db.run(`INSERT OR IGNORE INTO asset_references (site_id, asset_id, ref_type, ref_id, location) VALUES (?, ?, ?, ?, ?)`, [siteId, f.assetId, f.type, f.refId, f.location]);
    }
  });
  stampSetting(siteId, "last_reference_scan");
  return { cmsItems, pages: pageCount, references: found.length, warnings };
}

/** Recursively swaps one asset for another inside CMS field data. Returns the new value and whether anything changed. */
export function replaceAssetRefs(value: unknown, oldId: string, oldUrl: string, newId: string, newUrl: string): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    let next = value;
    if (oldUrl && next.includes(oldUrl)) next = next.split(oldUrl).join(newUrl);
    if (next.includes(oldId)) next = next.split(oldId).join(newId);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = replaceAssetRefs(v, oldId, oldUrl, newId, newUrl);
      changed = changed || r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "fileId" && v === oldId) {
        out[k] = newId;
        changed = true;
        continue;
      }
      const r = replaceAssetRefs(v, oldId, oldUrl, newId, newUrl);
      changed = changed || r.changed;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}
