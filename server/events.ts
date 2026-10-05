// Server-side events: a named booth setup (config + template images) that
// any device can load by scanning its setup QR, plus a private gallery of the
// photos shared at that event and the booths' summed counters.
//
// Three secrets per event:
//   ADMIN_TOKEN (env)   create / list / update / delete events
//   setupKey            load the setup, upload photos, push stats (booths)
//   galleryKey          view the gallery and download the ZIP (the host)
//
// Stored as EVENTS_DIR/<id>.json (default: next to SHARE_DIR, in ./events).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml, HttpError, page, type Req, type Res, readJson, sendHtml, sendJson } from './http.ts';
import { deletePhoto, jpgPath, listPhotos, SHARE_DIR, TTL_DAYS } from './photos.ts';
import { crc32 } from './zip.ts';

const EVENTS_DIR = path.resolve(process.env.EVENTS_DIR || path.join(SHARE_DIR, '..', 'events'));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_EVENT_BYTES = 10 * 1024 * 1024; // config + template images as data URLs
const EVENT_ID = /^[\w-]{6,32}$/;

const newKey = (bytes: number) => randomBytes(bytes).toString('base64url');
const eventFile = (id: string) => path.join(EVENTS_DIR, `${id}.json`);

// Stats as a booth reports them (see src/stats.ts); only numbers are summed.
type DeviceStats = Partial<Record<(typeof STAT_FIELDS)[number], number>> & { byHour?: Record<string, number> };

export interface EventImages {
  header: string | null;
  footer: string | null;
}

export interface StoredEvent {
  id: string;
  name: string;
  config: Record<string, unknown>;
  images: EventImages;
  created: string;
  updated: string;
  setupKey: string;
  galleryKey: string;
  stats: Record<string, DeviceStats>;
}

function safeEqual(a: unknown, b: unknown): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function isAdmin(req: Req): boolean {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  return !!ADMIN_TOKEN && !!m && safeEqual(m[1], ADMIN_TOKEN);
}

async function readEvent(id: string): Promise<StoredEvent | null> {
  if (!EVENT_ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(eventFile(id), 'utf8'));
  } catch {
    return null;
  }
}

async function writeEvent(ev: StoredEvent): Promise<void> {
  await mkdir(EVENTS_DIR, { recursive: true });
  await writeFile(eventFile(ev.id), JSON.stringify(ev));
}

// Used by the upload route: is this a real event with this setup key?
export async function verifyEventKey(id: unknown, key: unknown): Promise<StoredEvent | null> {
  const ev = await readEvent(String(id || ''));
  return ev && safeEqual(key, ev.setupKey) ? ev : null;
}

const STAT_FIELDS = ['sessions', 'prints', 'stickers', 'shares', 'failedPrints', 'printedMm'] as const;

type Totals = Record<(typeof STAT_FIELDS)[number], number> & { byHour: Record<string, number>; booths: number };

function sumStats(byDevice: Record<string, DeviceStats> = {}): Totals {
  const total: Totals = {
    sessions: 0,
    prints: 0,
    stickers: 0,
    shares: 0,
    failedPrints: 0,
    printedMm: 0,
    byHour: {},
    booths: 0,
  };
  for (const s of Object.values(byDevice)) {
    for (const f of STAT_FIELDS) total[f] += Number(s?.[f]) || 0;
    for (const [h, n] of Object.entries(s?.byHour ?? {})) total.byHour[h] = (total.byHour[h] ?? 0) + (Number(n) || 0);
  }
  total.booths = Object.keys(byDevice).length;
  return total;
}

interface SetupBody {
  name?: unknown;
  config?: unknown;
  images?: { header?: string | null; footer?: string | null };
}

function setupOf(body: SetupBody | null): Pick<StoredEvent, 'name' | 'config' | 'images'> {
  if (!body || typeof body.config !== 'object' || body.config === null) {
    throw new HttpError(400, 'Expected { name, config, images }.');
  }
  return {
    name: String(body.name || 'Untitled event').slice(0, 120),
    config: body.config as Record<string, unknown>,
    images: { header: body.images?.header ?? null, footer: body.images?.footer ?? null },
  };
}

// ---------- routes ----------

const API = /^\/api\/events(?:\/([\w-]+))?(\/stats)?$/;
const GALLERY = /^\/g\/([\w-]+)\/([\w-]+)(\/photos\.zip)?$/;

// Returns true when it handled the request.
export async function eventRoutes(req: Req, res: Res, url: URL): Promise<boolean> {
  const api = url.pathname.match(API);
  if (api) {
    await apiRoute(req, res, api[1], !!api[2]);
    return true;
  }
  const gallery = req.method === 'GET' && url.pathname.match(GALLERY);
  if (gallery) {
    const ev = await readEvent(gallery[1]);
    if (!ev || !safeEqual(gallery[2], ev.galleryKey)) {
      sendHtml(
        res,
        404,
        page(
          'Not found',
          '<h1>Gallery not found</h1><p class="muted">The link may be wrong or the event was deleted.</p>'
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

async function apiRoute(req: Req, res: Res, id: string | undefined, isStats: boolean): Promise<void> {
  const { method } = req;

  if (!id) {
    if (!ADMIN_TOKEN) return sendJson(res, 503, { error: 'Events are off: the server has no ADMIN_TOKEN.' });
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'Wrong admin token.' });
    if (method === 'GET') return sendJson(res, 200, { events: await listEvents() });
    if (method === 'POST') {
      const setup = setupOf(await readJson<SetupBody>(req, MAX_EVENT_BYTES));
      const now = new Date().toISOString();
      const ev = {
        id: newKey(9),
        ...setup,
        created: now,
        updated: now,
        setupKey: newKey(16),
        galleryKey: newKey(16),
        stats: {},
      };
      await writeEvent(ev);
      return sendJson(res, 201, { id: ev.id, name: ev.name, setupKey: ev.setupKey, galleryKey: ev.galleryKey });
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  const ev = await readEvent(id);
  if (!ev) return sendJson(res, 404, { error: 'No such event.' });
  const booth = safeEqual(req.headers['x-event-key'], ev.setupKey);

  if (isStats) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
    if (!booth) return sendJson(res, 401, { error: 'Wrong event key.' });
    const { device, stats } = await readJson<{ device?: unknown; stats?: DeviceStats }>(req, 64 * 1024);
    if (typeof device !== 'string' || !/^[\w-]{1,64}$/.test(device))
      return sendJson(res, 400, { error: 'Bad device id.' });
    ev.stats = { ...ev.stats, [device]: stats ?? {} };
    await writeEvent(ev);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET') {
    if (!booth && !isAdmin(req)) return sendJson(res, 401, { error: 'Wrong event key.' });
    return sendJson(res, 200, { id: ev.id, name: ev.name, config: ev.config, images: ev.images });
  }
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Wrong admin token.' });
  if (method === 'PUT') {
    Object.assign(ev, setupOf(await readJson<SetupBody>(req, MAX_EVENT_BYTES)), { updated: new Date().toISOString() });
    await writeEvent(ev);
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'DELETE') {
    for (const photo of await listPhotos({ event: ev.id })) await deletePhoto(photo.id);
    await rm(eventFile(ev.id), { force: true });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: 'Method not allowed.' });
}

async function listEvents() {
  const names = (await readdir(EVENTS_DIR).catch(() => [])).filter((n) => n.endsWith('.json'));
  const photos = await listPhotos();
  const events = [];
  for (const name of names) {
    const ev = await readEvent(name.slice(0, -5));
    if (!ev) continue;
    events.push({
      id: ev.id,
      name: ev.name,
      created: ev.created,
      updated: ev.updated,
      setupKey: ev.setupKey,
      galleryKey: ev.galleryKey,
      photos: photos.filter((p) => p.event === ev.id).length,
      stats: sumStats(ev.stats),
    });
  }
  return events.sort((a, b) => b.created.localeCompare(a.created));
}

// ---------- gallery ----------

async function sendGallery(res: Res, ev: StoredEvent, base: string): Promise<void> {
  const photos = await listPhotos({ event: ev.id });
  const s = sumStats(ev.stats);
  const busiest = Object.entries(s.byHour).sort((a, b) => b[1] - a[1])[0];
  const statLine = [
    `${photos.length} shared photo${photos.length === 1 ? '' : 's'}`,
    s.sessions && `${s.sessions} sessions`,
    s.stickers && `${s.stickers} stickers printed (${(s.printedMm / 1000).toFixed(1)} m of paper)`,
    busiest && `busiest hour ${busiest[0]}:00`,
  ]
    .filter(Boolean)
    .join(' · ');
  const expiry = TTL_DAYS > 0 ? `Photos are deleted automatically ${TTL_DAYS} days after they were taken.` : '';
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
