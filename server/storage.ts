// Where photo files live: an S3-compatible bucket when S3_BUCKET is set
// (production), otherwise `<id>.jpg` files in SHARE_DIR (local use, tests).
//
// The bucket is private. The app hands browsers a short-lived presigned URL
// (link()) and reads / writes objects itself with presigned requests, so no
// SDK is needed: AWS Signature V4 below is all node:crypto.
//
// Config (env):
//   S3_BUCKET, S3_ENDPOINT (https://…), S3_REGION, S3_ACCESS_KEY_ID,
//   S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE (true = endpoint/bucket/key,
//   else bucket.endpoint/key)
//   SHARE_DIR   folder for photos without a bucket (default ./shares)

import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SHARE_DIR } from './db.ts';
import { env } from './env.ts';

export interface PhotoStore {
  readonly kind: 'disk' | 's3';
  put(id: string, body: Buffer): Promise<void>;
  read(id: string): Promise<Buffer | null>;
  remove(id: string): Promise<void>;
  // A short-lived URL the browser can load the photo from directly, or null
  // when the app serves the file itself (disk).
  link(id: string): string | null;
}

// ---------- disk ----------

export function diskStore(dir: string): PhotoStore {
  const file = (id: string) => path.join(dir, `${id}.jpg`);
  return {
    kind: 'disk',
    async put(id, body) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(id), body);
    },
    read: (id) => readFile(file(id)).catch(() => null),
    async remove(id) {
      await rm(file(id), { force: true });
      await rm(path.join(dir, `${id}.json`), { force: true }); // pre-database sidecar
    },
    link: () => null,
  };
}

// ---------- S3 (Signature V4, presigned) ----------

export interface S3Config {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

// RFC 3986 encoding, as SigV4 wants it.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

// A presigned URL for `method` on `key`, valid `expiresSec` seconds. `query`
// adds signed parameters such as response-content-disposition.
export function presign(
  cfg: S3Config,
  method: string,
  key: string,
  expiresSec: number,
  query: Record<string, string> = {},
  now = new Date()
): string {
  const base = new URL(cfg.endpoint);
  const host = cfg.pathStyle ? base.host : `${cfg.bucket}.${base.host}`;
  const prefix = base.pathname.replace(/\/+$/, '');
  const objectPath = `${prefix}${cfg.pathStyle ? `/${cfg.bucket}` : ''}/${key}`;
  const canonicalUri = objectPath.split('/').map(enc).join('/');
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
    ...query,
  };
  const canonicalQuery = Object.keys(params)
    .map((k) => [enc(k), enc(params[k])])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join(
    '\n'
  );
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  let signingKey = hmac(`AWS4${cfg.secretAccessKey}`, date);
  for (const part of [cfg.region, 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `${base.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const REQUEST_TTL_SEC = 300; // the app's own requests
const LINK_TTL_SEC = 3600; // links handed to browsers

export function s3Store(cfg: S3Config): PhotoStore {
  const key = (id: string) => `shares/${id}.jpg`;
  const call = async (method: string, id: string, init: RequestInit = {}) => {
    const res = await fetch(presign(cfg, method, key(id), REQUEST_TTL_SEC), { method, ...init });
    return res;
  };
  const fail = async (what: string, res: Response): Promise<never> => {
    throw new Error(`S3 ${what} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
  return {
    kind: 's3',
    async put(id, body) {
      const res = await call('PUT', id, { body: new Uint8Array(body), headers: { 'Content-Type': 'image/jpeg' } });
      if (!res.ok) await fail('upload', res);
    },
    async read(id) {
      const res = await call('GET', id);
      if (res.status === 404) return null;
      if (!res.ok) await fail('download', res);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(id) {
      const res = await call('DELETE', id);
      if (!res.ok && res.status !== 404) await fail('delete', res);
    },
    link: (id) => presign(cfg, 'GET', key(id), LINK_TTL_SEC),
  };
}

// ---------- the store ----------

export function s3ConfigFromEnv(): S3Config | null {
  const bucket = env('S3_BUCKET');
  if (!bucket) return null;
  const missing = ['S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env(k));
  if (missing.length) throw new Error(`S3_BUCKET is set but ${missing.join(', ')} is not.`);
  return {
    bucket,
    endpoint: env('S3_ENDPOINT'),
    region: env('S3_REGION'),
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
    pathStyle: env('S3_FORCE_PATH_STYLE') === 'true' || env('S3_FORCE_PATH_STYLE') === '1',
  };
}

const s3 = s3ConfigFromEnv();
export const store: PhotoStore = s3 ? s3Store(s3) : diskStore(SHARE_DIR);
