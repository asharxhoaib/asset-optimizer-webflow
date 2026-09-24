// Hand-rolled typed client for Webflow Data API v2 (no SDK dependency).

import {
  WebflowAsset,
  WebflowAssetFolder,
  WebflowAssetFolderListResponse,
  WebflowAssetListResponse,
  WebflowAssetUpdate,
  WebflowAssetUploadResponse,
  WebflowCollectionItem,
  WebflowCollectionSummary,
  WebflowItemListResponse,
  WebflowPageListResponse,
  WebflowPageSummary,
  WebflowWebhook,
} from "../../shared/webflow-types";
import { refreshAccessToken } from "./oauth-service";
import { tokenStore } from "./token-store";

const API_BASE = "https://api.webflow.com/v2";
const MAX_429_RETRIES = 5;
const MAX_5XX_RETRIES = 2;
const PAGE_SIZE = 100;

export class WebflowApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Webflow API error ${status}: ${JSON.stringify(body)}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Token bucket sized for Webflow's 60 requests/minute limit: capacity 60, refilling one token per second.
 * block() lets a 429 pause every caller of the same site until the Retry-After window has passed.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private blockedUntil = 0;

  constructor(private capacity = 60, private refillPerMinute = 60) {
    this.tokens = capacity;
  }

  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
    this.tokens = 0;
    this.lastRefill = this.blockedUntil;
  }

  private refill(now: number): void {
    if (now <= this.lastRefill) return;
    const gained = ((now - this.lastRefill) / 60000) * this.refillPerMinute;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.blockedUntil) {
        await sleep(this.blockedUntil - now);
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.refillPerMinute) * 60000));
    }
  }
}

const limiters = new Map<string, TokenBucket>();
function limiterFor(siteId: string): TokenBucket {
  let l = limiters.get(siteId);
  if (!l) {
    l = new TokenBucket();
    limiters.set(siteId, l);
  }
  return l;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export class WebflowClient {
  private limiter: TokenBucket;

  constructor(public readonly siteId: string) {
    this.limiter = limiterFor(siteId);
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const qstr = qs.toString();
    const url = `${API_BASE}${path}${qstr ? `?${qstr}` : ""}`;

    let refreshed = false;
    let retries429 = 0;
    let retries5xx = 0;

    for (;;) {
      await this.limiter.acquire();
      const tokens = tokenStore.get(this.siteId);
      if (!tokens) throw new WebflowApiError(401, { message: `No stored token for site ${this.siteId}` });

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        if (await refreshAccessToken(this.siteId)) continue;
      }

      if (res.status === 429 && retries429 < MAX_429_RETRIES) {
        // Exponential backoff (1s, 2s, 4s...) but never shorter than the server's Retry-After.
        const backoff = 1000 * 2 ** retries429;
        const wait = Math.max(backoff, parseRetryAfterMs(res.headers.get("Retry-After")) ?? 0) + Math.floor(Math.random() * 250);
        this.limiter.block(wait);
        retries429++;
        continue;
      }

      if (res.status >= 500 && method === "GET" && retries5xx < MAX_5XX_RETRIES) {
        await sleep(500 * 2 ** retries5xx);
        retries5xx++;
        continue;
      }

      if (!res.ok) throw new WebflowApiError(res.status, await res.json().catch(() => ({})));
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  private async paged<R, I>(path: string, pick: (r: R) => I[], total: (r: R) => number | undefined): Promise<I[]> {
    const all: I[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.request<R>("GET", path, { query: { limit: PAGE_SIZE, offset } });
      const items = pick(page) ?? [];
      all.push(...items);
      offset += PAGE_SIZE;
      if (items.length === 0 || offset >= (total(page) ?? 0)) return all;
    }
  }

  /** GET /v2/sites/{siteId}/assets, paginated to completion. */
  listAssets(): Promise<WebflowAsset[]> {
    return this.paged<WebflowAssetListResponse, WebflowAsset>(`/sites/${this.siteId}/assets`, (r) => r.assets, (r) => r.pagination?.total);
  }

  /** GET /v2/assets/{assetId} */
  getAsset(assetId: string): Promise<WebflowAsset> {
    return this.request("GET", `/assets/${assetId}`);
  }

  /** PATCH /v2/assets/{assetId} (altText, displayName, parentFolder) */
  updateAsset(assetId: string, update: WebflowAssetUpdate): Promise<WebflowAsset> {
    return this.request("PATCH", `/assets/${assetId}`, { body: update });
  }

  /** DELETE /v2/assets/{assetId} (used only to clean up a failed upload) */
  async deleteAsset(assetId: string): Promise<void> {
    await this.request("DELETE", `/assets/${assetId}`);
  }

  /** GET /v2/sites/{siteId}/asset_folders */
  listAssetFolders(): Promise<WebflowAssetFolder[]> {
    return this.paged<WebflowAssetFolderListResponse, WebflowAssetFolder>(`/sites/${this.siteId}/asset_folders`, (r) => r.assetFolders, (r) => r.pagination?.total);
  }

  /** POST /v2/sites/{siteId}/asset_folders */
  createAssetFolder(displayName: string, parentFolder?: string | null): Promise<WebflowAssetFolder> {
    return this.request("POST", `/sites/${this.siteId}/asset_folders`, { body: { displayName, ...(parentFolder ? { parentFolder } : {}) } });
  }

  /** Step 1 of the presigned upload flow: POST /v2/sites/{siteId}/assets -> uploadUrl + asset id. */
  requestAssetUpload(fileName: string, fileHash: string, parentFolder?: string | null): Promise<WebflowAssetUploadResponse> {
    return this.request("POST", `/sites/${this.siteId}/assets`, { body: { fileName, fileHash, ...(parentFolder ? { parentFolder } : {}) } });
  }

  /**
   * Step 2: send the bytes to the presigned URL (not rate limited, no Bearer token).
   * When Webflow returns uploadDetails (S3 presigned POST fields) they are sent as multipart form fields
   * with the file last; otherwise the bytes are sent with a plain PUT.
   */
  async uploadToPresignedUrl(upload: WebflowAssetUploadResponse, data: Buffer, contentType: string, fileName: string): Promise<void> {
    let res: Response;
    if (upload.uploadDetails && Object.keys(upload.uploadDetails).length > 0) {
      const form = new FormData();
      for (const [k, v] of Object.entries(upload.uploadDetails)) form.append(k, v);
      form.append("file", new Blob([new Uint8Array(data)], { type: contentType }), fileName);
      res = await fetch(upload.uploadUrl, { method: "POST", body: form });
    } else {
      res = await fetch(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(data) });
    }
    if (!res.ok) throw new WebflowApiError(res.status, { message: "Presigned upload failed", body: await res.text().catch(() => "") });
  }

  async listCollections(): Promise<WebflowCollectionSummary[]> {
    const r = await this.request<{ collections: WebflowCollectionSummary[] }>("GET", `/sites/${this.siteId}/collections`);
    return r.collections ?? [];
  }

  /** GET /v2/collections/{collectionId}/items, paginated to completion. */
  listItems(collectionId: string): Promise<WebflowCollectionItem[]> {
    return this.paged<WebflowItemListResponse, WebflowCollectionItem>(`/collections/${collectionId}/items`, (r) => r.items, (r) => r.pagination?.total);
  }

  /** GET /v2/collections/{collectionId}/items/{itemId} */
  getItem(collectionId: string, itemId: string): Promise<WebflowCollectionItem> {
    return this.request("GET", `/collections/${collectionId}/items/${itemId}`);
  }

  /** PATCH /v2/collections/{collectionId}/items/{itemId} */
  updateItem(collectionId: string, itemId: string, fieldData: Record<string, unknown>): Promise<WebflowCollectionItem> {
    return this.request("PATCH", `/collections/${collectionId}/items/${itemId}`, { body: { fieldData } });
  }

  /** GET /v2/sites/{siteId}/pages */
  listPages(): Promise<WebflowPageSummary[]> {
    return this.paged<WebflowPageListResponse, WebflowPageSummary>(`/sites/${this.siteId}/pages`, (r) => r.pages, (r) => r.pagination?.total);
  }

  /** GET /v2/pages/{pageId}/dom (requires pages:read) */
  getPageDom(pageId: string): Promise<unknown> {
    return this.request("GET", `/pages/${pageId}/dom`);
  }

  async listWebhooks(): Promise<WebflowWebhook[]> {
    const r = await this.request<{ webhooks: WebflowWebhook[] }>("GET", `/sites/${this.siteId}/webhooks`);
    return r.webhooks ?? [];
  }

  createWebhook(triggerType: string, url: string): Promise<WebflowWebhook> {
    return this.request("POST", `/sites/${this.siteId}/webhooks`, { body: { triggerType, url } });
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request("DELETE", `/webhooks/${webhookId}`);
  }
}

const clients = new Map<string, WebflowClient>();

export function getClient(siteId: string): WebflowClient {
  let c = clients.get(siteId);
  if (!c) {
    c = new WebflowClient(siteId);
    clients.set(siteId, c);
  }
  return c;
}

export function forgetClient(siteId: string): void {
  clients.delete(siteId);
  limiters.delete(siteId);
}
