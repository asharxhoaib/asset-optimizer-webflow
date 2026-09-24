import "dotenv/config";

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num(process.env.PORT, 3000),
  publicUrl: (process.env.APP_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, ""),
  webflow: {
    clientId: process.env.WEBFLOW_CLIENT_ID || "",
    clientSecret: process.env.WEBFLOW_CLIENT_SECRET || "",
    redirectUri: process.env.WEBFLOW_REDIRECT_URI || "http://localhost:3000/oauth/callback",
    scopes: (process.env.WEBFLOW_SCOPES || "assets:read,assets:write,sites:read,cms:read").split(",").map((s) => s.trim()).filter(Boolean),
  },
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || "dev-only-insecure-key",
  altText: {
    provider: (process.env.ALT_TEXT_PROVIDER || "mock").toLowerCase(),
    httpUrl: process.env.ALT_TEXT_HTTP_URL || "",
    httpKey: process.env.ALT_TEXT_HTTP_KEY || "",
  },
  encoder: {
    httpUrl: process.env.ENCODER_HTTP_URL || "",
    httpKey: process.env.ENCODER_HTTP_KEY || "",
  },
  maxDownloadBytes: num(process.env.MAX_DOWNLOAD_MB, 50) * 1024 * 1024,
};
