import type {
  AltSuggestionDto,
  AssetDto,
  AuditSummary,
  FolderDto,
  JobDto,
  PlannedChange,
  SavingsReport,
  SettingsDto,
} from "../../shared/types";

type Tab = "assets" | "audit" | "alt" | "optimize" | "organize" | "report" | "settings";

interface Creds {
  siteId: string;
  token: string;
}

class ApiFailure extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const view = $<HTMLElement>("view");
let creds: Creds | null = null;
let current: Tab = "assets";
let dryRun = true;

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function bytes(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(2)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

function toast(message: string, error = false): void {
  const el = $<HTMLElement>("toast");
  el.textContent = message;
  el.className = error ? "toast error" : "toast";
  el.hidden = false;
  window.setTimeout(() => (el.hidden = true), 4000);
}

function loadCreds(): Creds | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fromHash = { siteId: hash.get("site") ?? "", token: hash.get("token") ?? "" };
  try {
    if (fromHash.siteId && fromHash.token) {
      sessionStorage.setItem("asset-creds", JSON.stringify(fromHash));
      history.replaceState(null, "", location.pathname);
      return fromHash;
    }
    const raw = sessionStorage.getItem("asset-creds");
    if (raw) return JSON.parse(raw) as Creds;
  } catch {
    if (fromHash.siteId && fromHash.token) return fromHash;
  }
  return null;
}

async function apiRaw(method: string, path: string, body?: unknown): Promise<Response> {
  if (!creds) throw new ApiFailure(401, "Not connected");
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Site-Id": creds.siteId, "X-Admin-Token": creds.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiFailure(res.status, json.error ?? `Request failed (${res.status})`);
  }
  return res;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await (await apiRaw(method, path, body)).json()) as T;
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

function wire(selector: string, handler: (el: HTMLElement) => Promise<void> | void): void {
  view.querySelectorAll<HTMLElement>(selector).forEach((el) => el.addEventListener("click", () => void guard(async () => handler(el))));
}

const val = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "";

function changesTable(changes: PlannedChange[]): string {
  if (changes.length === 0) return `<p class="muted">Nothing to change.</p>`;
  return `<table><tr><th>Before</th><th>After</th><th>Status</th></tr>${changes
    .map((c) => `<tr><td>${esc(c.before)}</td><td>${esc(c.after)}</td><td>${c.error ? `<span class="tag failed">${esc(c.error)}</span>` : c.applied ? `<span class="tag completed">applied</span>` : `<span class="tag planned">planned</span>`}</td></tr>`)
    .join("")}</table>`;
}

async function renderAssets(): Promise<void> {
  const [{ assets }, { folders }] = await Promise.all([api<{ assets: AssetDto[] }>("GET", "/assets"), api<{ folders: FolderDto[] }>("GET", "/folders")]);
  view.innerHTML = `<div class="row"><span class="muted">${assets.length} assets, ${folders.length} folders</span>
    <button class="btn small" id="refs">Scan references</button><button class="btn small" id="hashes">Fetch hashes and sizes</button></div>
    <table><tr><th></th><th>Name</th><th>Folder</th><th>Type</th><th>Size</th><th>Dimensions</th><th>Alt</th><th>Refs</th></tr>${assets
      .map(
        (a) => `<tr><td>${a.mimeType.startsWith("image/") && a.hostedUrl ? `<img class="thumb" loading="lazy" src="${esc(a.hostedUrl)}" alt="" />` : ""}</td>
        <td>${esc(a.displayName)}</td><td>${esc(a.folderPath || "(root)")}</td><td>${esc(a.mimeType)}</td><td>${bytes(a.sizeBytes)}</td>
        <td>${a.width && a.height ? `${a.width}x${a.height}` : "-"}</td><td><span class="tag ${a.altStatus}">${a.altStatus}</span></td><td>${a.refCount}</td></tr>`
      )
      .join("")}</table>`;
  $("refs").onclick = () => void guard(async () => {
    const r = await api<{ references: number; warnings: string[] }>("POST", "/sync/references");
    toast(`Found ${r.references} references${r.warnings.length ? `. ${r.warnings[0]}` : ""}`, r.warnings.length > 0);
    await render();
  });
  $("hashes").onclick = () => void guard(async () => {
    const r = await api<{ updated: number; failed: number }>("POST", "/sync/hashes", { limit: 50 });
    toast(`Updated ${r.updated} assets (${r.failed} failed)`);
    await render();
  });
}

async function renderAudit(): Promise<void> {
  const audit = await api<AuditSummary>("GET", "/audit");
  view.innerHTML = `<div class="row"><button class="btn primary" id="run">Run audit</button><span class="muted">${audit.total} active assets</span></div>
    ${audit.warnings.map((w) => `<div class="banner">${esc(w)}</div>`).join("")}
    <div class="row">${Object.entries(audit.counts).map(([k, n]) => `<span class="tag ${k}">${esc(k)}: ${n}</span>`).join(" ")}</div>
    <table><tr><th>Asset</th><th>Finding</th><th>Detail</th></tr>${audit.findings.map((f) => `<tr><td>${esc(f.displayName)}</td><td><span class="tag ${f.kind}">${f.kind}</span></td><td>${esc(f.detail)}</td></tr>`).join("")}</table>`;
  $("run").onclick = () => void guard(async () => {
    const r = await api<AuditSummary>("POST", "/audit/run");
    toast(`Audit found ${r.findings.length} issues`);
    await render();
  });
}

async function renderAlt(): Promise<void> {
  const { suggestions } = await api<{ suggestions: AltSuggestionDto[] }>("GET", "/alt-text?status=pending");
  view.innerHTML = `<div class="row"><button class="btn primary" id="suggest">Suggest for images missing alt text</button>
    <span class="muted">${dryRun ? "Dry run: approvals will not be written." : "Approvals are written to Webflow."}</span></div>
    <table><tr><th></th><th>Asset</th><th>Suggested alt text</th><th></th></tr>${suggestions
      .map(
        (s) => `<tr><td>${s.hostedUrl ? `<img class="thumb" loading="lazy" src="${esc(s.hostedUrl)}" alt="" />` : ""}</td><td>${esc(s.displayName)}</td>
        <td><input class="wide" id="alt-${s.id}" value="${esc(s.suggestion)}" /></td>
        <td><button class="btn small primary" data-approve="${s.id}">Approve</button> <button class="btn small" data-reject="${s.id}">Reject</button></td></tr>`
      )
      .join("")}</table>`;
  $("suggest").onclick = () => void guard(async () => {
    const r = await api<{ created: number; failed: number }>("POST", "/alt-text/suggest", {});
    toast(`Created ${r.created} suggestions (${r.failed} failed)`);
    await render();
  });
  wire("[data-approve]", async (el) => {
    const id = el.dataset.approve as string;
    const r = await api<PlannedChange>("POST", `/alt-text/${id}/approve`, { text: val(`alt-${id}`), dryRun });
    toast(r.applied ? "Alt text saved to Webflow" : "Dry run: alt text would be updated");
    await render();
  });
  wire("[data-reject]", async (el) => {
    await api("POST", `/alt-text/${el.dataset.reject}/reject`);
    await render();
  });
}

async function renderOptimize(): Promise<void> {
  const [{ assets }, { jobs }] = await Promise.all([api<{ assets: AssetDto[] }>("GET", "/assets"), api<{ jobs: JobDto[] }>("GET", "/optimize/jobs")]);
  const candidates = assets.filter((a) => a.mimeType.startsWith("image/") && a.mimeType !== "image/svg+xml" && a.mimeType !== "image/webp" && a.mimeType !== "image/avif").slice(0, 25);
  view.innerHTML = `<div class="card"><h2>Largest re-encodable images</h2>
    <div class="row"><button class="btn primary" id="opt-all">${dryRun ? "Plan optimization" : "Optimize"} (${candidates.length})</button></div>
    <table><tr><th>Name</th><th>Type</th><th>Size</th></tr>${candidates.map((a) => `<tr><td>${esc(a.displayName)}</td><td>${esc(a.mimeType)}</td><td>${bytes(a.sizeBytes)}</td></tr>`).join("")}</table></div>
    <h2>Jobs</h2><table><tr><th>Asset</th><th>Status</th><th>Before</th><th>After</th><th>Note</th></tr>${jobs
      .map((j) => `<tr><td>${esc(j.displayName)}</td><td><span class="tag ${j.status}">${j.status}${j.dryRun ? " (dry)" : ""}</span></td><td>${bytes(j.originalBytes)}</td><td>${j.newBytes === null ? "-" : bytes(j.newBytes)}</td><td>${esc(j.note)}</td></tr>`)
      .join("")}</table>`;
  $("opt-all").onclick = () => void guard(async () => {
    if (candidates.length === 0) return toast("No candidates", true);
    await api("POST", "/optimize", { assetIds: candidates.map((a) => a.assetId), dryRun });
    toast(dryRun ? "Plan recorded" : "Optimization finished");
    await render();
  });
}

async function renderOrganize(): Promise<void> {
  const s = await api<SettingsDto>("GET", "/settings");
  view.innerHTML = `<div class="card"><h2>Bulk rename</h2>
    <p class="muted">Tokens: {name} {slug} {ext} {folder} {type} {year} {month} {width} {height} {index}. Extension is preserved.</p>
    <div class="row"><input class="wide" id="rn-template" value="${esc(s.namingTemplate)}" /><input class="wide" id="rn-filter" placeholder="Only names matching regex (optional)" />
    <button class="btn primary" id="rn-run">${dryRun ? "Preview" : "Rename"}</button></div><div id="rn-out"></div></div>
    <div class="card"><h2>Folder organization</h2>
    <div class="row"><input class="wide" id="fo-template" value="${esc(s.folderTemplate)}" /><button class="btn primary" id="fo-run">${dryRun ? "Preview" : "Move"}</button></div><div id="fo-out"></div></div>`;
  $("rn-run").onclick = () => void guard(async () => {
    const r = await api<{ changes: PlannedChange[] }>("POST", "/organize/rename", { template: val("rn-template"), onlyMatching: val("rn-filter"), dryRun });
    $("rn-out").innerHTML = changesTable(r.changes);
  });
  $("fo-run").onclick = () => void guard(async () => {
    const r = await api<{ changes: PlannedChange[] }>("POST", "/organize/folders", { template: val("fo-template"), dryRun });
    $("fo-out").innerHTML = changesTable(r.changes);
  });
}

async function renderReport(): Promise<void> {
  const r = await api<SavingsReport>("GET", "/report");
  view.innerHTML = `<div class="stats"><div><div class="stat">${bytes(r.savedBytes)}</div><div class="muted">saved (${r.savedPct}%)</div></div>
    <div><div class="stat">${r.totalJobs}</div><div class="muted">optimized assets</div></div>
    <div><div class="stat">${bytes(r.originalBytes)} to ${bytes(r.newBytes)}</div><div class="muted">before / after</div></div></div>
    <div class="row"><button class="btn" id="csv">Download CSV</button></div>
    <table><tr><th>Folder</th><th>Jobs</th><th>Before</th><th>After</th><th>Saved</th></tr>${r.perFolder.map((f) => `<tr><td>${esc(f.folderPath)}</td><td>${f.jobs}</td><td>${bytes(f.originalBytes)}</td><td>${bytes(f.newBytes)}</td><td>${bytes(f.savedBytes)}</td></tr>`).join("")}</table>`;
  $("csv").onclick = () => void guard(async () => {
    const blob = await (await apiRaw("GET", "/report.csv")).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "asset-savings.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

async function renderSettings(): Promise<void> {
  const s = await api<SettingsDto>("GET", "/settings");
  view.innerHTML = `<div class="card grid2">
    <label>Max file size (bytes)<input id="s-max" class="num" type="number" value="${s.maxBytes}" /></label>
    <label>Modern formats (MIME, comma separated)<input id="s-modern" value="${esc(s.modernFormats)}" /></label>
    <label>Target format<select id="s-target"><option value="image/webp">image/webp</option><option value="image/avif">image/avif</option></select></label>
    <label>Quality (1-100)<input id="s-quality" class="num" type="number" value="${s.quality}" /></label>
    <label>Minimum savings (%)<input id="s-min" class="num" type="number" value="${s.minSavingsPct}" /></label>
    <label>Archive folder<input id="s-archive" value="${esc(s.archiveFolderName)}" /></label>
    <label>Naming template<input id="s-naming" value="${esc(s.namingTemplate)}" /></label>
    <label>Folder template<input id="s-folder" value="${esc(s.folderTemplate)}" /></label></div>
    <div class="row"><button class="btn primary" id="s-save">Save settings</button>
    <span class="muted">Last sync: ${esc(s.lastAssetSync ?? "never")}. Last reference scan: ${esc(s.lastReferenceScan ?? "never")}.</span></div>`;
  ($("s-target") as unknown as HTMLSelectElement).value = s.targetFormat;
  $("s-save").onclick = () => void guard(async () => {
    await api("PUT", "/settings", {
      maxBytes: Number(val("s-max")),
      modernFormats: val("s-modern"),
      targetFormat: val("s-target"),
      quality: Number(val("s-quality")),
      minSavingsPct: Number(val("s-min")),
      archiveFolderName: val("s-archive"),
      namingTemplate: val("s-naming"),
      folderTemplate: val("s-folder"),
      dryRun,
    });
    toast("Settings saved");
  });
}

const renderers: Record<Tab, () => Promise<void>> = {
  assets: renderAssets,
  audit: renderAudit,
  alt: renderAlt,
  optimize: renderOptimize,
  organize: renderOrganize,
  report: renderReport,
  settings: renderSettings,
};

async function render(): Promise<void> {
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === current));
  await guard(() => renderers[current]());
}

async function start(): Promise<void> {
  creds = loadCreds();
  $("connect").hidden = !!creds;
  $("main").hidden = !creds;
  if (!creds) {
    $("conn-save").onclick = () => {
      const siteId = val("conn-site");
      const token = val("conn-token");
      if (!siteId || !token) return toast("Site ID and token are required", true);
      try {
        sessionStorage.setItem("asset-creds", JSON.stringify({ siteId, token }));
      } catch {
        // Session storage unavailable; credentials live in memory only.
      }
      creds = { siteId, token };
      void start();
    };
    return;
  }
  const settings = await api<SettingsDto>("GET", "/settings").catch(() => null);
  dryRun = settings ? settings.dryRun : true;
  const box = $("dry-run") as unknown as HTMLInputElement;
  box.checked = dryRun;
  box.onchange = () => void guard(async () => {
    dryRun = box.checked;
    await api("PUT", "/settings", { dryRun });
    await render();
  });
  $("sync-all").onclick = () => void guard(async () => {
    const r = await api<{ assets: number; folders: number }>("POST", "/sync");
    toast(`Synced ${r.assets} assets and ${r.folders} folders`);
    await render();
  });
  $("tabs").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".tab");
    if (!t) return;
    current = t.dataset.tab as Tab;
    void render();
  });
  await render();
}

void start();
