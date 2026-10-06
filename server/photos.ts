// Shared-photo storage: `<id>.jpg` files in SHARE_DIR, metadata in the
// database (see db.ts). Handles expiry and the disk quota.
//
// A photo expires SHARE_TTL_DAYS after it was taken, unless it belongs to a
// paid event: then the event's retention applies (PAID_RETENTION_DAYS by
// default, or the event's own retention_days).
//
// Config (env):
//   SHARE_DIR            where photos are stored (default ./shares)
//   SHARE_TTL_DAYS       free retention (default 30, 0 = keep forever)
//   PAID_RETENTION_DAYS  retention for paid events (default 365)
//   SHARE_MAX_MB         refuse uploads once photos take this much (default 5000)

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db, SHARE_DIR } from './db.ts';
import { envNumber } from './env.ts';

export { SHARE_DIR };
export const TTL_DAYS = envNumber('SHARE_TTL_DAYS', 30);
export const PAID_RETENTION_DAYS = envNumber('PAID_RETENTION_DAYS', 365);
const MAX_BYTES = envNumber('SHARE_MAX_MB', 5000) * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export const ID = /^[0-9a-f-]{36}$/;

export interface PhotoMeta {
  id: string;
  event: string | null;
  created: string;
  retentionDays: number; // 0 = kept forever
}

export const jpgPath = (id: string) => path.join(SHARE_DIR, `${id}.jpg`);

// Retention in days for a row joined with its event (see SELECT_META).
const SELECT_META = `
  SELECT p.id, p.event_id AS event, p.created,
    CASE WHEN e.paid = 1 THEN COALESCE(e.retention_days, ${PAID_RETENTION_DAYS}) ELSE ${TTL_DAYS} END AS retentionDays
  FROM photos p LEFT JOIN events e ON e.id = p.event_id`;

export async function hasRoomFor(bytes: number): Promise<boolean> {
  const { used } = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS used FROM photos').get() as { used: number };
  return used + bytes <= MAX_BYTES;
}

export async function savePhoto(id: string, body: Buffer, event: string | null = null): Promise<void> {
  await mkdir(SHARE_DIR, { recursive: true });
  await writeFile(jpgPath(id), body);
  db.prepare('INSERT INTO photos (id, event_id, created, bytes) VALUES (?, ?, ?, ?)').run(
    id,
    event,
    new Date().toISOString(),
    body.length
  );
}

export async function photoMeta(id: string): Promise<PhotoMeta | null> {
  return (db.prepare(`${SELECT_META} WHERE p.id = ?`).get(id) as unknown as PhotoMeta | undefined) ?? null;
}

export async function deletePhoto(id: string): Promise<void> {
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  await rm(jpgPath(id), { force: true });
  // Pre-database sidecars, if any.
  await rm(path.join(SHARE_DIR, `${id}.json`), { force: true });
}

export async function listPhotos({ event }: { event?: string | null } = {}): Promise<PhotoMeta[]> {
  const rows =
    event === undefined
      ? db.prepare(`${SELECT_META} ORDER BY p.created`).all()
      : event === null
        ? db.prepare(`${SELECT_META} WHERE p.event_id IS NULL ORDER BY p.created`).all()
        : db.prepare(`${SELECT_META} WHERE p.event_id = ? ORDER BY p.created`).all(event);
  return rows as unknown as PhotoMeta[];
}

export function countPhotos(event: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM photos WHERE event_id = ?').get(event) as { n: number }).n;
}

export function expiresAt(meta: Pick<PhotoMeta, 'created' | 'retentionDays'>): Date | null {
  return meta.retentionDays > 0 ? new Date(new Date(meta.created).getTime() + meta.retentionDays * DAY_MS) : null;
}

export async function cleanup(): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const meta of await listPhotos()) {
    const expires = expiresAt(meta);
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
