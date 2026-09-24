import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { db } from "../db";

export function newAdminToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Guards App Panel API calls: X-Site-Id + X-Admin-Token issued at install time. */
export function requireSite(req: Request, res: Response, next: NextFunction): void {
  const siteId = req.header("x-site-id");
  const token = req.header("x-admin-token");
  if (!siteId || !token) {
    res.status(401).json({ error: "Missing X-Site-Id or X-Admin-Token" });
    return;
  }
  const row = db.get<{ admin_token_hash: string }>(`SELECT admin_token_hash FROM installations WHERE site_id = ?`, [siteId]);
  if (!row || !row.admin_token_hash || !safeEqual(row.admin_token_hash, hashToken(token))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  res.locals.siteId = siteId;
  next();
}

export function siteOf(res: Response): string {
  return res.locals.siteId as string;
}
