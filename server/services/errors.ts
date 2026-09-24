import { NextFunction, Request, RequestHandler, Response } from "express";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function toHttpError(err: unknown): HttpError | null {
  return err instanceof HttpError ? err : null;
}

export function strParam(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${name} is required`);
  return value.trim();
}

export function idListParam(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || !v)) {
    throw new HttpError(400, `${name} must be a non-empty array of ids`);
  }
  return value as string[];
}
