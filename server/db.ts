// SQLite (node:sqlite, no dependency) for events, photos, payments and admin
// sessions. Photo files stay on disk in SHARE_DIR; this holds their metadata.
//
// Config (env):
//   DB_PATH     database file (default: EVENTS_DIR/photoboot.db, so it lives
//               on the same persistent volume as the old JSON events)
//   EVENTS_DIR  where pre-database events (<id>.json) are imported from
//   SHARE_DIR   where pre-database photo sidecars (<id>.json) are imported from

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SHARE_DIR = path.resolve(process.env.SHARE_DIR || 'shares');
export const EVENTS_DIR = path.resolve(process.env.EVENTS_DIR || path.join(SHARE_DIR, '..', 'events'));
const DB_PATH = process.env.DB_PATH || path.join(EVENTS_DIR, 'photoboot.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  event_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',      -- 'pending' until paid, then 'active'
  paid INTEGER NOT NULL DEFAULT 0,            -- 1 = paid or comped: gallery + long retention
  retention_days INTEGER,                     -- photo retention when paid (NULL = default)
  source TEXT NOT NULL DEFAULT 'admin',       -- admin | stripe | apple | comp | legacy
  setup_key TEXT NOT NULL,
  gallery_key TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  images TEXT NOT NULL DEFAULT '{}',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  created TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS photos_event ON photos(event_id);
CREATE TABLE IF NOT EXISTS stats (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device TEXT NOT NULL,
  stats TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (event_id, device)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,                     -- stripe | apple | comp
  ref TEXT NOT NULL UNIQUE,                   -- checkout session / transaction id
  amount INTEGER NOT NULL DEFAULT 0,          -- minor units (cents)
  currency TEXT NOT NULL DEFAULT 'eur',
  status TEXT NOT NULL,                       -- paid | refunded
  created TEXT NOT NULL,
  raw TEXT
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  expires TEXT NOT NULL,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function open(): DatabaseSync {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  if (Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) < 1) {
    importLegacy(db);
    db.exec('PRAGMA user_version = 1');
  }
  return db;
}

// Events and photo metadata from before the database (JSON files). The files
// stay where they are; importing is idempotent.
function importLegacy(db: DatabaseSync) {
  const readJson = (file: string) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const now = new Date().toISOString();
  if (existsSync(EVENTS_DIR)) {
    const insert = db.prepare(`INSERT OR IGNORE INTO events
      (id, name, status, paid, source, setup_key, gallery_key, config, images, created, updated)
      VALUES (?, ?, 'active', 1, 'legacy', ?, ?, ?, ?, ?, ?)`);
    const stat = db.prepare('INSERT OR IGNORE INTO stats (event_id, device, stats, updated) VALUES (?, ?, ?, ?)');
    for (const name of readdirSync(EVENTS_DIR).filter((n) => n.endsWith('.json'))) {
      const ev = readJson(path.join(EVENTS_DIR, name));
      if (!ev?.id || !ev.setupKey || !ev.galleryKey) continue;
      insert.run(
        ev.id,
        String(ev.name ?? 'Untitled event'),
        ev.setupKey,
        ev.galleryKey,
        JSON.stringify(ev.config ?? {}),
        JSON.stringify(ev.images ?? {}),
        ev.created ?? now,
        ev.updated ?? now
      );
      for (const [device, s] of Object.entries(ev.stats ?? {})) stat.run(ev.id, device, JSON.stringify(s), now);
    }
  }
  if (existsSync(SHARE_DIR)) {
    const known = new Set((db.prepare('SELECT id FROM events').all() as { id: string }[]).map((r) => r.id));
    const insert = db.prepare('INSERT OR IGNORE INTO photos (id, event_id, created, bytes) VALUES (?, ?, ?, ?)');
    for (const name of readdirSync(SHARE_DIR).filter((n) => n.endsWith('.jpg'))) {
      const id = name.slice(0, -4);
      const file = path.join(SHARE_DIR, name);
      const meta = readJson(path.join(SHARE_DIR, `${id}.json`));
      const info = statSync(file);
      const event = meta?.event && known.has(meta.event) ? meta.event : null;
      insert.run(id, event, meta?.created ?? info.mtime.toISOString(), info.size);
    }
  }
}

export const db = open();

// Small helpers so callers don't repeat the JSON handling.
export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
}
