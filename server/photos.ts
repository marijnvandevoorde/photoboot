// Shared-photo storage: `<id>.jpg` plus a `<id>.json` sidecar
// ({ id, event, created }) in SHARE_DIR. Handles expiry and the disk quota.
//
// Config (env):
//   SHARE_DIR       where photos are stored (default ./shares)
//   SHARE_TTL_DAYS  delete photos older than this (default 30, 0 = keep forever)
//   SHARE_MAX_MB    refuse uploads once the folder is this big (default 5000)

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SHARE_DIR = path.resolve(process.env.SHARE_DIR || 'shares');
export const TTL_DAYS = Number(process.env.SHARE_TTL_DAYS ?? 30);
const MAX_BYTES = Number(process.env.SHARE_MAX_MB ?? 5000) * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export const ID = /^[0-9a-f-]{36}$/;

export interface PhotoMeta {
  id: string;
  event: string | null;
  created: string;
}

const jpgPath = (id: string) => path.join(SHARE_DIR, `${id}.jpg`);
const metaPath = (id: string) => path.join(SHARE_DIR, `${id}.json`);

export { jpgPath };

let usedBytes: number | null = null; // folder size, computed lazily, then kept up to date

async function folderBytes(): Promise<number> {
  if (usedBytes !== null) return usedBytes;
  let total = 0;
  for (const name of await readdir(SHARE_DIR).catch(() => [])) {
    total += (await stat(path.join(SHARE_DIR, name)).catch(() => ({ size: 0 }))).size;
  }
  usedBytes = total;
  return total;
}

export async function hasRoomFor(bytes: number): Promise<boolean> {
  return (await folderBytes()) + bytes <= MAX_BYTES;
}

export async function savePhoto(id: string, body: Buffer, event: string | null = null): Promise<void> {
  await mkdir(SHARE_DIR, { recursive: true });
  const meta = JSON.stringify({ id, event, created: new Date().toISOString() });
  await writeFile(jpgPath(id), body);
  await writeFile(metaPath(id), meta);
  if (usedBytes !== null) usedBytes += body.length + meta.length;
}

// { id, event, created } — falls back to the file time for photos uploaded
// before sidecars existed.
export async function photoMeta(id: string): Promise<PhotoMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(id), 'utf8'));
  } catch {
    const info = await stat(jpgPath(id)).catch(() => null);
    return info ? { id, event: null, created: info.mtime.toISOString() } : null;
  }
}

export async function deletePhoto(id: string): Promise<void> {
  for (const file of [jpgPath(id), metaPath(id)]) {
    const size = (await stat(file).catch(() => ({ size: 0 }))).size;
    await rm(file, { force: true });
    if (usedBytes !== null) usedBytes -= size;
  }
}

export async function listPhotos({ event }: { event?: string | null } = {}): Promise<PhotoMeta[]> {
  const names = await readdir(SHARE_DIR).catch(() => []);
  const ids = names
    .filter((n) => n.endsWith('.jpg'))
    .map((n) => n.slice(0, -4))
    .filter((id) => ID.test(id));
  const metas = await Promise.all(ids.map(photoMeta));
  return metas
    .filter((m): m is PhotoMeta => !!m && (event === undefined || m.event === event))
    .sort((a, b) => a.created.localeCompare(b.created));
}

export function expiresAt(created: string): Date | null {
  return TTL_DAYS > 0 ? new Date(new Date(created).getTime() + TTL_DAYS * 86_400_000) : null;
}

export async function cleanup() {
  if (!(TTL_DAYS > 0)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const meta of await listPhotos()) {
    const expires = expiresAt(meta.created);
    if (expires && expires.getTime() < now) {
      await deletePhoto(meta.id);
      removed++;
    }
  }
  if (removed) console.log(`photoboot: removed ${removed} expired photo(s)`);
  return removed;
}

// Runs in whichever process loads this module (prod server or Vite dev).
cleanup().catch((err) => console.error('cleanup failed', err));
setInterval(() => cleanup().catch((err) => console.error('cleanup failed', err)), CLEANUP_INTERVAL_MS).unref();
