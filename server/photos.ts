// Shared photos: the files in the photo store (storage.ts: a bucket, or
// SHARE_DIR locally), metadata in the database (db.ts). Handles expiry and
// the storage quota.
//
// A photo expires SHARE_TTL_DAYS after it was taken, unless it belongs to a
// paid event: then the event's retention applies (PAID_RETENTION_DAYS by
// default, or the event's own retention_days).
//
// Config (env):
//   SHARE_TTL_DAYS       free retention (default 30, 0 = keep forever)
//   PAID_RETENTION_DAYS  retention for paid events (default 365)
//   SHARE_MAX_MB         refuse uploads once photos take this much (default 5000)

import { db } from './db.ts';
import { envNumber } from './env.ts';
import { store } from './storage.ts';

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

// Retention in days for a row joined with its event (see SELECT_META).
const SELECT_META = `
  SELECT p.id, p.event_id AS event, p.created,
    CASE WHEN e.paid = 1 THEN COALESCE(e.retention_days, ${PAID_RETENTION_DAYS}) ELSE ${TTL_DAYS} END AS retentionDays
  FROM photos p LEFT JOIN events e ON e.id = p.event_id`;

export async function hasRoomFor(bytes: number): Promise<boolean> {
  const row = await db.get<{ used: number }>('SELECT COALESCE(SUM(bytes), 0) AS used FROM photos');
  return Number(row?.used ?? 0) + bytes <= MAX_BYTES;
}

export async function savePhoto(id: string, body: Buffer, event: string | null = null): Promise<void> {
  await store.put(id, body);
  await db.run(
    'INSERT INTO photos (id, event_id, created, bytes) VALUES (?, ?, ?, ?)',
    id,
    event,
    new Date().toISOString(),
    body.length
  );
}

export async function photoMeta(id: string): Promise<PhotoMeta | null> {
  const row = await db.get<PhotoMeta>(`${SELECT_META} WHERE p.id = ?`, id);
  return row ? { ...row, retentionDays: Number(row.retentionDays) } : null;
}

export async function deletePhoto(id: string): Promise<void> {
  await db.run('DELETE FROM photos WHERE id = ?', id);
  await store.remove(id);
}

export async function listPhotos({ event }: { event?: string | null } = {}): Promise<PhotoMeta[]> {
  const rows =
    event === undefined
      ? await db.all<PhotoMeta>(`${SELECT_META} ORDER BY p.created`)
      : event === null
        ? await db.all<PhotoMeta>(`${SELECT_META} WHERE p.event_id IS NULL ORDER BY p.created`)
        : await db.all<PhotoMeta>(`${SELECT_META} WHERE p.event_id = ? ORDER BY p.created`, event);
  return rows.map((r) => ({ ...r, retentionDays: Number(r.retentionDays) }));
}

export async function countPhotos(event: string): Promise<number> {
  const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM photos WHERE event_id = ?', event);
  return Number(row?.n ?? 0);
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
