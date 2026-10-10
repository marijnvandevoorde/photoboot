// Server-side events: a named booth setup (config + template images) that
// any device can load with its setup link, plus a private gallery of the
// photos shared at that event and the booths' summed counters.
//
// Two secrets per event, handed out as links (see mail.ts / admin):
//   setupKey    load and save the setup, upload photos, push stats (booths)
//   galleryKey  view the gallery and download the ZIP (the host)
// The owner manages all events in /admin (admin.ts).
//
// An event is 'pending' until it's paid (billing.ts); pending events don't
// accept photos and have no gallery yet.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { db } from './db.ts';
import { escapeHtml, HttpError, page, type Req, type Res, readJson, sendHtml, sendJson } from './http.ts';
import { countPhotos, deletePhoto, jpgPath, listPhotos, PAID_RETENTION_DAYS, TTL_DAYS } from './photos.ts';
import { crc32 } from './zip.ts';

const MAX_EVENT_BYTES = 10 * 1024 * 1024; // config + template images as data URLs
const EVENT_ID = /^[\w-]{6,32}$/;

export const newKey = (bytes: number) => randomBytes(bytes).toString('base64url');

// Stats as a booth reports them (see src/stats.ts); only numbers are summed.
const STAT_FIELDS = ['sessions', 'prints', 'stickers', 'shares', 'failedPrints', 'printedMm'] as const;
type DeviceStats = Partial<Record<(typeof STAT_FIELDS)[number], number>> & { byHour?: Record<string, number> };
export type Totals = Record<(typeof STAT_FIELDS)[number], number> & { byHour: Record<string, number>; booths: number };

export interface EventImages {
  header: string | null;
  footer: string | null;
}

export type EventStatus = 'pending' | 'active';
export type EventSource = 'admin' | 'stripe' | 'apple' | 'comp' | 'legacy';

export interface StoredEvent {
  id: string;
  name: string;
  email: string | null;
  eventDate: string | null;
  status: EventStatus;
  paid: boolean;
  retentionDays: number | null;
  source: EventSource;
  setupKey: string;
  galleryKey: string;
  config: Record<string, unknown>;
  images: EventImages;
  created: string;
  updated: string;
}

interface EventRow {
  id: string;
  name: string;
  email: string | null;
  event_date: string | null;
  status: EventStatus;
  paid: number;
  retention_days: number | null;
  source: EventSource;
  setup_key: string;
  gallery_key: string;
  config: string;
  images: string;
  created: string;
  updated: string;
}

const fromRow = (r: EventRow): StoredEvent => ({
  id: r.id,
  name: r.name,
  email: r.email,
  eventDate: r.event_date,
  status: r.status,
  paid: r.paid === 1,
  retentionDays: r.retention_days,
  source: r.source,
  setupKey: r.setup_key,
  galleryKey: r.gallery_key,
  config: JSON.parse(r.config || '{}'),
  images: { header: null, footer: null, ...JSON.parse(r.images || '{}') },
  created: r.created,
  updated: r.updated,
});

export function safeEqual(a: unknown, b: unknown): boolean {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ---------- store ----------

export function getEvent(id: string): StoredEvent | null {
  if (!EVENT_ID.test(id)) return null;
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  return row ? fromRow(row) : null;
}

export interface NewEvent {
  name: string;
  email?: string | null;
  eventDate?: string | null;
  status?: EventStatus;
  paid?: boolean;
  source: EventSource;
  config?: Record<string, unknown>;
  images?: EventImages;
}

export function createEvent(input: NewEvent): StoredEvent {
  const now = new Date().toISOString();
  const id = newKey(9);
  db.prepare(
    `INSERT INTO events (id, name, email, event_date, status, paid, source, setup_key, gallery_key, config, images, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name.slice(0, 120),
    input.email ?? null,
    input.eventDate ?? null,
    input.status ?? 'active',
    input.paid ? 1 : 0,
    input.source,
    newKey(16),
    newKey(16),
    JSON.stringify(input.config ?? { eventName: input.name }),
    JSON.stringify(input.images ?? { header: null, footer: null }),
    now,
    now
  );
  return getEvent(id) as StoredEvent;
}

export function updateEvent(
  id: string,
  fields: Partial<
    Pick<StoredEvent, 'name' | 'email' | 'eventDate' | 'status' | 'paid' | 'retentionDays' | 'config' | 'images'>
  >
) {
  const cols: Record<string, unknown> = {
    name: fields.name,
    email: fields.email,
    event_date: fields.eventDate,
    status: fields.status,
    paid: fields.paid === undefined ? undefined : fields.paid ? 1 : 0,
    retention_days: fields.retentionDays,
    config: fields.config === undefined ? undefined : JSON.stringify(fields.config),
    images: fields.images === undefined ? undefined : JSON.stringify(fields.images),
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (!set.length) return;
  db.prepare(`UPDATE events SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated = ? WHERE id = ?`).run(
    ...(set.map(([, v]) => v) as (string | number | null)[]),
    new Date().toISOString(),
    id
  );
}

export async function deleteEvent(id: string): Promise<void> {
  for (const photo of await listPhotos({ event: id })) await deletePhoto(photo.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
}

export interface EventSummary extends StoredEvent {
  photos: number;
  stats: Totals;
}

export function listEvents({ q = '', limit = 200 }: { q?: string; limit?: number } = {}): EventSummary[] {
  const like = `%${q.trim()}%`;
  const rows = db
    .prepare('SELECT * FROM events WHERE name LIKE ? OR email LIKE ? OR id = ? ORDER BY created DESC LIMIT ?')
    .all(like, like, q.trim(), limit) as unknown as EventRow[];
  return rows.map((r) => {
    const ev = fromRow(r);
    return { ...ev, photos: countPhotos(ev.id), stats: eventStats(ev.id) };
  });
}

// Used by the upload route: is this an active event with this setup key?
export async function verifyEventKey(id: unknown, key: unknown): Promise<StoredEvent | null> {
  const ev = getEvent(String(id || ''));
  return ev && ev.status === 'active' && safeEqual(key, ev.setupKey) ? ev : null;
}

export function retentionOf(ev: Pick<StoredEvent, 'paid' | 'retentionDays'>): number {
  return ev.paid ? (ev.retentionDays ?? PAID_RETENTION_DAYS) : TTL_DAYS;
}

// ---------- stats ----------

function sumStats(byDevice: DeviceStats[]): Totals {
  const total: Totals = {
    sessions: 0,
    prints: 0,
    stickers: 0,
    shares: 0,
    failedPrints: 0,
    printedMm: 0,
    byHour: {},
    booths: byDevice.length,
  };
  for (const s of byDevice) {
    for (const f of STAT_FIELDS) total[f] += Number(s?.[f]) || 0;
    for (const [h, n] of Object.entries(s?.byHour ?? {})) total.byHour[h] = (total.byHour[h] ?? 0) + (Number(n) || 0);
  }
  return total;
}

export function eventStats(id: string): Totals {
  const rows = db.prepare('SELECT stats FROM stats WHERE event_id = ?').all(id) as { stats: string }[];
  return sumStats(rows.map((r) => JSON.parse(r.stats)));
}

interface SetupBody {
  name?: unknown;
  config?: unknown;
  images?: { header?: string | null; footer?: string | null };
}

function setupOf(body: SetupBody | null): { config: Record<string, unknown>; images: EventImages } {
  if (!body || typeof body.config !== 'object' || body.config === null) {
    throw new HttpError(400, 'Expected { config, images }.');
  }
  return {
    config: body.config as Record<string, unknown>,
    images: { header: body.images?.header ?? null, footer: body.images?.footer ?? null },
  };
}

// ---------- routes ----------

const API = /^\/api\/events\/([\w-]+)(\/stats)?$/;
const GALLERY = /^\/g\/([\w-]+)\/([\w-]+)(\/photos\.zip)?$/;

// Returns true when it handled the request.
export async function eventRoutes(req: Req, res: Res, url: URL): Promise<boolean> {
  const api = url.pathname.match(API);
  if (api) {
    await boothRoute(req, res, api[1], !!api[2]);
    return true;
  }
  const gallery = req.method === 'GET' && url.pathname.match(GALLERY);
  if (gallery) {
    const ev = getEvent(gallery[1]);
    if (!ev || !safeEqual(gallery[2], ev.galleryKey)) {
      sendHtml(
        res,
        404,
        page(
          'Not found',
          '<h1>Gallery not found</h1><p class="muted">The link may be wrong or the event was deleted.</p>'
        )
      );
    } else if (ev.status !== 'active') {
      sendHtml(
        res,
        402,
        page(
          ev.name,
          `<h1>${escapeHtml(ev.name)}</h1><p class="muted">This event isn't active yet: the payment hasn't come through.</p>`
        )
      );
    } else if (gallery[3]) {
      await sendZip(res, ev);
    } else {
      await sendGallery(res, ev, url.pathname);
    }
    return true;
  }
  return false;
}

// The routes a booth uses, all with the event's setup key.
async function boothRoute(req: Req, res: Res, id: string, isStats: boolean): Promise<void> {
  const ev = getEvent(id);
  if (!ev) return sendJson(res, 404, { error: 'No such event.' });
  if (!safeEqual(req.headers['x-event-key'], ev.setupKey)) return sendJson(res, 401, { error: 'Wrong event key.' });
  if (ev.status !== 'active') return sendJson(res, 402, { error: "This event isn't paid yet." });

  if (isStats) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
    const { device, stats } = await readJson<{ device?: unknown; stats?: DeviceStats }>(req, 64 * 1024);
    if (typeof device !== 'string' || !/^[\w-]{1,64}$/.test(device))
      return sendJson(res, 400, { error: 'Bad device id.' });
    db.prepare(
      `INSERT INTO stats (event_id, device, stats, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, device) DO UPDATE SET stats = excluded.stats, updated = excluded.updated`
    ).run(ev.id, device, JSON.stringify(stats ?? {}), new Date().toISOString());
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET') {
    return sendJson(res, 200, { id: ev.id, name: ev.name, config: ev.config, images: ev.images });
  }
  // A booth saves its setup to the event, so the other booths can load it.
  if (req.method === 'PUT') {
    updateEvent(ev.id, setupOf(await readJson<SetupBody>(req, MAX_EVENT_BYTES)));
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: 'Method not allowed.' });
}

// ---------- gallery ----------

async function sendGallery(res: Res, ev: StoredEvent, base: string): Promise<void> {
  const photos = await listPhotos({ event: ev.id });
  const s = eventStats(ev.id);
  const busiest = Object.entries(s.byHour).sort((a, b) => b[1] - a[1])[0];
  const statLine = [
    `${photos.length} shared photo${photos.length === 1 ? '' : 's'}`,
    s.sessions && `${s.sessions} sessions`,
    s.stickers && `${s.stickers} stickers printed (${(s.printedMm / 1000).toFixed(1)} m of paper)`,
    busiest && `busiest hour ${busiest[0]}:00`,
  ]
    .filter(Boolean)
    .join(' · ');
  const days = retentionOf(ev);
  const expiry = days > 0 ? `Photos are deleted automatically ${days} days after they were taken.` : '';
  const grid = photos
    .map(
      (p) =>
        `<a href="/s/${p.id}"><img src="/share/${p.id}.jpg" loading="lazy" alt="Photo from ${escapeHtml(p.created)}"></a>`
    )
    .join('');
  sendHtml(
    res,
    200,
    page(
      ev.name,
      `<h1>${escapeHtml(ev.name)}</h1>
<p class="muted">${escapeHtml(statLine)}</p>
${photos.length ? `<div class="actions"><a class="btn" href="${escapeHtml(base)}/photos.zip">Download all (ZIP)</a></div>` : ''}
<div class="grid">${grid || '<p class="muted">No shared photos yet. Only photos guests pressed “Get photo” on appear here.</p>'}</div>
<p class="muted">${escapeHtml(expiry)} Only photos guests shared are on the server; the booth device keeps a copy of every photo.</p>`
    )
  );
}

// Streams a stored (uncompressed) ZIP, one photo in memory at a time.
async function sendZip(res: Res, ev: StoredEvent): Promise<void> {
  const photos = await listPhotos({ event: ev.id });
  const slug =
    ev.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || ev.id;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${slug}.zip"`,
    'Cache-Control': 'no-store',
  });
  const write = (buf: Buffer) =>
    new Promise<void>((resolve) => (res.write(buf) ? resolve() : res.once('drain', () => resolve())));
  const central: Buffer[] = [];
  let offset = 0;
  for (const [i, p] of photos.entries()) {
    const data = await readFile(jpgPath(p.id)).catch(() => null);
    if (!data) continue;
    const name = Buffer.from(`${slug}-${String(i + 1).padStart(4, '0')}.jpg`);
    const date = new Date(p.created);
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, name]));
    await write(Buffer.concat([local, name]));
    await write(data);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(dir);
  res.end(end);
}
