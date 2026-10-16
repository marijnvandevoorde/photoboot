// One-off move from local storage to MySQL + a bucket: copies every row of a
// SQLite database into the database at DATABASE_URL, and every photo file
// into the bucket at S3_*, then checks both. Safe to run again: rows that
// already exist are skipped, photos are written again.
//
//   DATABASE_URL=mysql://… S3_BUCKET=… (and the other S3_*) \
//     node server/import-sqlite.ts /data/events/photoboot.db /data/shares
//
// Stop the app first, so the SQLite database doesn't change underneath.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [file, photoDir] = process.argv.slice(2);
if (!file || !photoDir) {
  console.error('usage: node server/import-sqlite.ts <photoboot.db> <photo folder>');
  process.exit(2);
}
if (!process.env.DATABASE_URL || !process.env.S3_BUCKET) {
  console.error('Set DATABASE_URL and S3_* first: this copies into them.');
  process.exit(2);
}

const { db, insertIgnore } = await import('./db.ts');
const { store } = await import('./storage.ts');

type Row = Record<string, string | number | null>;
const src = new DatabaseSync(file, { readOnly: true });

// Parents before children, for the foreign keys.
const TABLES = ['events', 'photos', 'stats', 'payments', 'admin_sessions', 'settings', 'apple_tokens'];
let problems = 0;

for (const table of TABLES) {
  const exists = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const rows = exists ? (src.prepare(`SELECT * FROM ${table}`).all() as Row[]) : [];
  let added = 0;
  for (const row of rows) {
    const cols = Object.keys(row);
    added += (await db.run(insertIgnore(table, cols), ...cols.map((c) => row[c]))).changes;
  }
  const target = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
  console.log(`${table}: sqlite ${rows.length}, added ${added}, mysql now ${target}`);
  if (target < rows.length) {
    console.error(`  ${table}: MySQL has fewer rows than SQLite`);
    problems++;
  }
}

const photos = src.prepare('SELECT id, bytes FROM photos').all() as { id: string; bytes: number }[];
let copied = 0;
let missing = 0;
for (const { id, bytes } of photos) {
  const data = await readFile(path.join(photoDir, `${id}.jpg`)).catch(() => null);
  if (!data) {
    console.warn(`  photo ${id}: no file on disk (row kept)`);
    missing++;
    continue;
  }
  await store.put(id, data);
  const back = await store.read(id);
  if (!back?.equals(data)) {
    console.error(`  photo ${id}: the bucket copy differs`);
    problems++;
    continue;
  }
  if (data.length !== Number(bytes)) console.warn(`  photo ${id}: ${data.length} bytes on disk, ${bytes} in the row`);
  copied++;
}
console.log(`photos: ${photos.length} rows, ${copied} files copied and verified, ${missing} without a file`);

src.close();
await db.close();
console.log(problems ? `done: ${problems} problem(s)` : 'done: OK');
process.exit(problems ? 1 : 0);
