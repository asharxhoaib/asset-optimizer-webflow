import { HttpError } from "./errors";

export interface NamingContext {
  name: string; // file name without extension
  ext: string; // extension without dot
  mimeType: string;
  folderName: string;
  width: number | null;
  height: number | null;
  createdOn: string;
  index: number;
}

export const TEMPLATE_TOKENS = ["name", "slug", "ext", "folder", "type", "format", "year", "month", "width", "height", "index"] as const;

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function assetType(mime: string): string {
  if (mime.startsWith("image/svg")) return "vector";
  if (mime.startsWith("image/")) return "images";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "documents";
  return "other";
}

export function validateTemplate(template: string): void {
  const re = /\{([a-z]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (!(TEMPLATE_TOKENS as readonly string[]).includes(m[1])) throw new HttpError(400, `Unknown template token {${m[1]}}. Allowed: ${TEMPLATE_TOKENS.map((t) => `{${t}}`).join(", ")}`);
  }
  if (template.replace(/\{[a-z]+\}/g, "").includes("{") || template.replace(/\{[a-z]+\}/g, "").includes("}")) throw new HttpError(400, "Template has unbalanced braces");
}

export function renderTemplate(template: string, ctx: NamingContext): string {
  const created = new Date(ctx.createdOn);
  const valid = !Number.isNaN(created.getTime());
  const values: Record<string, string> = {
    name: ctx.name,
    slug: slugify(ctx.name),
    ext: ctx.ext,
    folder: slugify(ctx.folderName),
    type: assetType(ctx.mimeType),
    format: ctx.ext,
    year: valid ? String(created.getUTCFullYear()) : "undated",
    month: valid ? String(created.getUTCMonth() + 1).padStart(2, "0") : "00",
    width: ctx.width ? String(ctx.width) : "",
    height: ctx.height ? String(ctx.height) : "",
    index: String(ctx.index).padStart(3, "0"),
  };
  return template.replace(/\{([a-z]+)\}/g, (_m, key: string) => values[key] ?? "");
}

export function splitFileName(fileName: string): { name: string; ext: string } {
  const m = /^(.*?)(?:\.([A-Za-z0-9]{1,5}))?$/.exec(fileName);
  return { name: m?.[1] ?? fileName, ext: (m?.[2] ?? "").toLowerCase() };
}
