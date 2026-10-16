// The database for events, photos, payments and admin sessions: MySQL when
// DATABASE_URL is set (production), otherwise SQLite in a local file
// (node:sqlite, no dependency; local use and the tests). Photo files live in
// the photo store (storage.ts); this only holds their metadata.
//
// Callers write plain SQL that both dialects accept, through the async `db`
// (get / all / run), and use `insertIgnore()` / `upsert()` for the two
// statements whose syntax differs. Quote the column `key` as `key`.
//
// Config (env):
//   DATABASE_URL  mysql://user:pass@host:3306/name?ssl-mode=REQUIRED
//                 (ssl-mode: DISABLED, REQUIRED = TLS without verifying the
//                 certificate, VERIFY_CA / VERIFY_IDENTITY = verify it)
//   DB_PATH       SQLite file (default: EVENTS_DIR/photoboot.db)
//   EVENTS_DIR    where pre-database events (<id>.json) are imported from
//   SHARE_DIR     where pre-database photo sidecars (<id>.json) are imported from

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from './env.ts';

export const SHARE_DIR = path.resolve(process.env.SHARE_DIR || 'shares');
export const EVENTS_DIR = path.resolve(process.env.EVENTS_DIR || path.join(SHARE_DIR, '..', 'events'));
export const DB_PATH = process.env.DB_PATH || path.join(EVENTS_DIR, 'photoboot.db');

export type Param = string | number | null;

export interface Db {
  readonly kind: 'sqlite' | 'mysql';
  get<T>(sql: string, ...params: Param[]): Promise<T | undefined>;
  all<T>(sql: string, ...params: Param[]): Promise<T[]>;
  run(sql: string, ...params: Param[]): Promise<{ changes: number }>;
  close(): Promise<void>;
}

// ---------- SQLite ----------

const SQLITE_SCHEMA = `
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

// Later SQLite schema changes, in order; each runs once, in a transaction.
const SQLITE_MIGRATIONS: [number, string][] = [
  [
    2,
    // Apple in-app purchase (apple.ts): the appAccountToken handed to the app
    // for a pending event. StoreKit signs it into the transaction, which ties
    // the purchase to that event.
    `CREATE TABLE apple_tokens (
      token TEXT PRIMARY KEY,                   -- lowercase UUID
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      created TEXT NOT NULL
    );
    CREATE INDEX apple_tokens_event ON apple_tokens(event_id);`,
  ],
];

export function openSqlite(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SQLITE_SCHEMA);
  const version = () => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version() < 1) {
    importLegacy(db);
    db.exec('PRAGMA user_version = 1');
  }
  for (const [to, sql] of SQLITE_MIGRATIONS) {
    if (version() >= to) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${to}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
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

function sqliteDb(file: string): Db {
  const db = openSqlite(file);
  return {
    kind: 'sqlite',
    get: async <T>(sql: string, ...params: Param[]) => db.prepare(sql).get(...params) as T | undefined,
    all: async <T>(sql: string, ...params: Param[]) => db.prepare(sql).all(...params) as T[],
    run: async (sql: string, ...params: Param[]) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
    close: async () => db.close(),
  };
}

// ---------- MySQL ----------

// Ids, keys and timestamps are ASCII and compared exactly (ascii_bin), so
// event ids differing only in case stay distinct. Timestamps are ISO strings,
// as in SQLite, so they sort and compare the same way.
const ID = 'CHARACTER SET ascii COLLATE ascii_bin';
const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(64) ${ID} NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NULL,
    event_date VARCHAR(32) ${ID} NULL,
    status VARCHAR(16) ${ID} NOT NULL DEFAULT 'active',
    paid TINYINT NOT NULL DEFAULT 0,
    retention_days INT NULL,
    source VARCHAR(16) ${ID} NOT NULL DEFAULT 'admin',
    setup_key VARCHAR(64) ${ID} NOT NULL,
    gallery_key VARCHAR(64) ${ID} NOT NULL,
    config LONGTEXT NOT NULL,
    images LONGTEXT NOT NULL,
    created VARCHAR(32) ${ID} NOT NULL,
    updated VARCHAR(32) ${ID} NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS photos (
    id VARCHAR(64) ${ID} NOT NULL PRIMARY KEY,
    event_id VARCHAR(64) ${ID} NULL,
    created VARCHAR(32) ${ID} NOT NULL,
    bytes INT NOT NULL DEFAULT 0,
    KEY photos_event (event_id),
    CONSTRAINT photos_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS stats (
    event_id VARCHAR(64) ${ID} NOT NULL,
    device VARCHAR(64) ${ID} NOT NULL,
    stats MEDIUMTEXT NOT NULL,
    updated VARCHAR(32) ${ID} NOT NULL,
    PRIMARY KEY (event_id, device),
    CONSTRAINT stats_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(64) ${ID} NULL,
    provider VARCHAR(16) ${ID} NOT NULL,
    ref VARCHAR(255) ${ID} NOT NULL,
    amount INT NOT NULL DEFAULT 0,
    currency VARCHAR(8) ${ID} NOT NULL DEFAULT 'eur',
    status VARCHAR(16) ${ID} NOT NULL,
    created VARCHAR(32) ${ID} NOT NULL,
    raw MEDIUMTEXT NULL,
    UNIQUE KEY payments_ref (ref),
    KEY payments_event (event_id),
    CONSTRAINT payments_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash VARCHAR(64) ${ID} NOT NULL PRIMARY KEY,
    created VARCHAR(32) ${ID} NOT NULL,
    expires VARCHAR(32) ${ID} NOT NULL,
    ip VARCHAR(64) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(64) ${ID} NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS apple_tokens (
    token VARCHAR(64) ${ID} NOT NULL PRIMARY KEY,
    event_id VARCHAR(64) ${ID} NOT NULL,
    created VARCHAR(32) ${ID} NOT NULL,
    KEY apple_tokens_event (event_id),
    CONSTRAINT apple_tokens_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];
// The MySQL schema is created whole. A later change needs a numbered
// migration like SQLITE_MIGRATIONS, recorded in `settings`.

async function mysqlDb(url: string): Promise<Db> {
  const { createPool } = await import('mysql2/promise');
  const u = new URL(url);
  const sslMode = (u.searchParams.get('ssl-mode') ?? u.searchParams.get('sslmode') ?? '').toUpperCase();
  const pool = createPool({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    charset: 'utf8mb4',
    ssl:
      sslMode && sslMode !== 'DISABLED'
        ? { rejectUnauthorized: sslMode === 'VERIFY_CA' || sslMode === 'VERIFY_IDENTITY' }
        : undefined,
    connectionLimit: 5,
    decimalNumbers: true, // SUM() is a DECIMAL: a number, not a string
    enableKeepAlive: true,
  });
  for (const sql of MYSQL_SCHEMA) await pool.query(sql);
  const rows = async <T>(sql: string, params: Param[]) => (await pool.query(sql, params))[0] as T[];
  return {
    kind: 'mysql',
    get: async <T>(sql: string, ...params: Param[]) => (await rows<T>(sql, params))[0],
    all: <T>(sql: string, ...params: Param[]) => rows<T>(sql, params),
    run: async (sql: string, ...params: Param[]) => {
      const [result] = await pool.query(sql, params);
      return { changes: Number((result as { affectedRows?: number }).affectedRows ?? 0) };
    },
    close: () => pool.end(),
  };
}

// ---------- the database ----------

const DATABASE_URL = env('DATABASE_URL');
export const db: Db = DATABASE_URL ? await mysqlDb(DATABASE_URL) : sqliteDb(DB_PATH);

const q = (col: string) => `\`${col}\``;

// INSERT that skips rows whose primary / unique key already exists.
export function insertIgnore(table: string, cols: string[]): string {
  const verb = db.kind === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
  return `${verb} INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
}

// INSERT, or UPDATE the non-key columns when `keys` already exist.
export function upsert(table: string, cols: string[], keys: string[]): string {
  const insert = `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const rest = cols.filter((c) => !keys.includes(c));
  return db.kind === 'mysql'
    ? `${insert} AS new ON DUPLICATE KEY UPDATE ${rest.map((c) => `${q(c)} = new.${q(c)}`).join(', ')}`
    : `${insert} ON CONFLICT(${keys.map(q).join(', ')}) DO UPDATE SET ${rest.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`;
}

// Small helpers so callers don't repeat the JSON handling.
export async function getSetting(key: string): Promise<string | null> {
  const row = await db.get<{ value: string }>('SELECT value FROM settings WHERE `key` = ?', key);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  if (value === null) await db.run('DELETE FROM settings WHERE `key` = ?', key);
  else await db.run(upsert('settings', ['key', 'value'], ['key']), key, value);
}
