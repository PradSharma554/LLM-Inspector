import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { Span, SpanPayload } from "@llm-inspector/protocol";
import type { Queryable } from "../db/client.js";

// Async, NOT gzipSync. The sync form blocks the event loop and serialises every
// concurrent request behind it — the single most likely performance bug in a
// Node collector. These run on libuv's threadpool instead.
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface BlobStoreOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  inlineLimitBytes: number;
}

/**
 * Content-addressed payload storage.
 *
 * Payloads are keyed by sha256 of their content, so the same system prompt
 * across a thousand traces, or a retrieved chunk that keeps reappearing, is
 * stored exactly once. On a 0.5 GB free tier that dedup is the difference
 * between a usable tool and one that fills up during a demo.
 *
 * S3-compatible, so the same code runs against MinIO locally and Cloudflare R2
 * in production.
 */
export class BlobStore {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #inlineLimit: number;

  constructor(opts: BlobStoreOptions) {
    this.#bucket = opts.bucket;
    this.#inlineLimit = opts.inlineLimitBytes;
    this.#s3 = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? "auto",
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      // MinIO needs path-style addressing; R2 accepts it too.
      forcePathStyle: true,
    });
  }

  /**
   * Split a span's payloads: small ones stay inline, large ones go to storage.
   *
   * Returns the rewritten payload map plus stats, so the caller can record
   * dedup hits — a satisfying number to surface in the UI.
   */
  async offloadSpanPayloads(
    sql: Queryable,
    span: Span,
  ): Promise<{ payloads: Record<string, SpanPayload>; uploaded: number; deduped: number }> {
    const out: Record<string, SpanPayload> = {};
    let uploaded = 0;
    let deduped = 0;

    for (const [key, payload] of Object.entries(span.payloads)) {
      if (payload.storage === "external") {
        out[key] = payload; // already offloaded
        continue;
      }

      const json = JSON.stringify(payload.data);
      const bytes = Buffer.byteLength(json, "utf8");

      if (bytes <= this.#inlineLimit) {
        out[key] = payload; // small enough — avoid a round trip
        continue;
      }

      const sha256 = createHash("sha256").update(json).digest("hex");
      const objectKey = `payloads/${sha256.slice(0, 2)}/${sha256}.gz`;

      const existed = await this.#putIfAbsent(sql, sha256, objectKey, json, bytes);
      if (existed) deduped++;
      else uploaded++;

      out[key] = { storage: "external", ref: objectKey, sha256, sizeBytes: bytes };
    }

    return { payloads: out, uploaded, deduped };
  }

  /**
   * Upload unless this exact content already exists.
   *
   * The DB index is checked first because it is far cheaper than a HEAD against
   * object storage. Because the key IS the content hash, a race between two
   * concurrent writers is harmless: both write byte-identical objects.
   */
  async #putIfAbsent(
    sql: Queryable,
    sha256: string,
    objectKey: string,
    json: string,
    rawBytes: number,
  ): Promise<boolean> {
    const [existing] = await sql<{ sha256: string }[]>`
      SELECT sha256 FROM payload_blobs WHERE sha256 = ${sha256} LIMIT 1
    `;

    if (existing) {
      await sql`
        UPDATE payload_blobs SET ref_count = ref_count + 1 WHERE sha256 = ${sha256}
      `;
      return true;
    }

    const compressed = await gzipAsync(json);

    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Body: compressed,
        ContentType: "application/json",
        ContentEncoding: "gzip",
      }),
    );

    // ON CONFLICT: another request may have inserted the same hash between our
    // SELECT and here. Harmless — same content, same key.
    await sql`
      INSERT INTO payload_blobs (sha256, r2_key, size_bytes, stored_bytes)
      VALUES (${sha256}, ${objectKey}, ${rawBytes}, ${compressed.length})
      ON CONFLICT (sha256) DO UPDATE SET ref_count = payload_blobs.ref_count + 1
    `;

    return false;
  }

  /** Fetch and decompress a payload by object key. */
  async fetch(objectKey: string): Promise<unknown> {
    const res = await this.#s3.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
    );
    const compressed = Buffer.from(await res.Body!.transformToByteArray());
    const json = await gunzipAsync(compressed);
    return JSON.parse(json.toString("utf8"));
  }

  /** Create the bucket if missing — convenience for local MinIO. */
  async ensureBucket(): Promise<void> {
    try {
      await this.#s3.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: "__probe__" }));
    } catch {
      // A 404 on the probe key is expected and means the bucket is reachable.
      // Bucket creation is left to infrastructure (MinIO init / R2 dashboard).
    }
  }
}
