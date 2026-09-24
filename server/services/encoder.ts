// Pluggable image re-encoding. Implement ImageEncoder to use sharp, libvips, squoosh or a hosted service.
import { config } from "../config";

export interface EncodeOptions {
  targetFormat: string; // MIME type, e.g. image/webp
  quality: number; // 1-100
}

export interface EncodedImage {
  data: Buffer;
  mimeType: string;
}

export interface ImageEncoder {
  readonly name: string;
  encode(input: Buffer, sourceMime: string, opts: EncodeOptions): Promise<EncodedImage>;
}

export const EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/avif": "avif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

/** Returns the input unchanged. Keeps the pipeline exercisable end to end when no real encoder is configured. */
export class PassthroughEncoder implements ImageEncoder {
  readonly name = "passthrough";

  async encode(input: Buffer, sourceMime: string): Promise<EncodedImage> {
    return { data: input, mimeType: sourceMime };
  }
}

/**
 * POSTs the raw bytes to an HTTP encoder service with `X-Target-Format` and `X-Quality` headers and
 * expects the re-encoded bytes back with a Content-Type header.
 */
export class HttpEncoder implements ImageEncoder {
  readonly name = "http";

  constructor(private url: string, private apiKey: string) {}

  async encode(input: Buffer, sourceMime: string, opts: EncodeOptions): Promise<EncodedImage> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": sourceMime,
        "X-Target-Format": opts.targetFormat,
        "X-Quality": String(opts.quality),
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: new Uint8Array(input),
    });
    if (!res.ok) throw new Error(`Encoder responded ${res.status}`);
    const mimeType = (res.headers.get("content-type") ?? opts.targetFormat).split(";")[0].trim();
    return { data: Buffer.from(await res.arrayBuffer()), mimeType };
  }
}

let encoder: ImageEncoder | null = null;

export function getEncoder(): ImageEncoder {
  if (!encoder) {
    encoder = config.encoder.httpUrl ? new HttpEncoder(config.encoder.httpUrl, config.encoder.httpKey) : new PassthroughEncoder();
  }
  return encoder;
}

export function setEncoder(e: ImageEncoder): void {
  encoder = e;
}
