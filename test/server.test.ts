import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The real app on a random port, with photos and events in a temp folder.
// The server modules read their env at import, so set it first.
let dir: string;
let server: Server;
let base: string;
let cleanup: () => Promise<number>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'photoboot-test-'));
  process.env.SHARE_DIR = path.join(dir, 'shares');
  process.env.EVENTS_DIR = path.join(dir, 'events');
  process.env.ADMIN_TOKEN = 'test-admin';
  process.env.SHARE_TTL_DAYS = '30';
  delete process.env.BASE_URL;
  const { createApp } = await import('../server/index.ts');
  ({ cleanup } = await import('../server/photos.ts'));
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const admin = { Authorization: 'Bearer test-admin' };

async function upload(headers: Record<string, string> = {}) {
  return fetch(`${base}/api/share`, {
    method: 'POST',
    body: JPEG,
    headers: { 'Content-Type': 'image/jpeg', ...headers },
  });
}

async function createEvent(name = 'Party') {
  const res = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config: { copies: 2 }, images: { header: null, footer: null } }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; setupKey: string; galleryKey: string };
}

describe('sharing', () => {
  it('stores a JPEG and serves its page and image', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    const { id, url } = await res.json();
    expect(url).toBe(`${base}/s/${id}`);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/deleted automatically on \d{4}-\d{2}-\d{2}/);

    const img = await fetch(`${base}/share/${id}.jpg`);
    expect(img.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(Buffer.from(await img.arrayBuffer())).toEqual(JPEG);
  });

  it('rejects anything that is not a JPEG', async () => {
    const res = await fetch(`${base}/api/share`, { method: 'POST', body: 'hello' });
    expect(res.status).toBe(400);
  });

  it('deletes a photo by its id', async () => {
    const { id } = await (await upload()).json();
    expect((await fetch(`${base}/api/share/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/share/${id}.jpg`)).status).toBe(404);
    expect((await fetch(`${base}/s/${id}`)).status).toBe(404);
  });

  it('deletes expired photos and keeps fresh ones', async () => {
    const old = (await (await upload()).json()).id;
    const fresh = (await (await upload()).json()).id;
    const meta = path.join(dir, 'shares', `${old}.json`);
    const data = JSON.parse(await readFile(meta, 'utf8'));
    await writeFile(meta, JSON.stringify({ ...data, created: '2020-01-01T00:00:00.000Z' }));
    expect(await cleanup()).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${base}/share/${old}.jpg`)).status).toBe(404);
    expect((await fetch(`${base}/share/${fresh}.jpg`)).status).toBe(200);
  });

  it('answers a malformed URL with 400 instead of crashing', async () => {
    expect((await fetch(`${base}/%E0`)).status).toBe(400);
    expect((await fetch(`${base}/api/events`, { headers: admin })).status).toBe(200); // still alive
  });
});

describe('events', () => {
  it('needs the admin token', async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    expect((await fetch(`${base}/api/events`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('hands the setup to booths with the setup key only', async () => {
    const ev = await createEvent('Setup test');
    expect((await fetch(`${base}/api/events/${ev.id}`, { headers: { 'X-Event-Key': 'wrong' } })).status).toBe(401);
    const res = await fetch(`${base}/api/events/${ev.id}`, { headers: { 'X-Event-Key': ev.setupKey } });
    expect(await res.json()).toMatchObject({ id: ev.id, name: 'Setup test', config: { copies: 2 } });
  });

  it('tags uploads with the event and refuses a wrong key', async () => {
    const ev = await createEvent('Gallery test');
    const bad = await upload({ 'X-Event-Id': ev.id, 'X-Event-Key': 'wrong' });
    expect(bad.status).toBe(401);
    for (let i = 0; i < 2; i++)
      expect((await upload({ 'X-Event-Id': ev.id, 'X-Event-Key': ev.setupKey })).status).toBe(201);

    const stats = {
      sessions: 5,
      prints: 3,
      stickers: 4,
      shares: 2,
      failedPrints: 0,
      printedMm: 300,
      byHour: { '21': 5 },
    };
    await fetch(`${base}/api/events/${ev.id}/stats`, {
      method: 'POST',
      headers: { 'X-Event-Key': ev.setupKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'booth-1', stats }),
    });

    const { events } = await (await fetch(`${base}/api/events`, { headers: admin })).json();
    expect(events.find((e: { id: string }) => e.id === ev.id)).toMatchObject({
      photos: 2,
      stats: { sessions: 5, booths: 1 },
    });

    const gallery = await fetch(`${base}/g/${ev.id}/${ev.galleryKey}`);
    const html = await gallery.text();
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('busiest hour 21:00');
    expect((await fetch(`${base}/g/${ev.id}/wrong-key`)).status).toBe(404);

    const zip = Buffer.from(await (await fetch(`${base}/g/${ev.id}/${ev.galleryKey}/photos.zip`)).arrayBuffer());
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 12)).toBe(2);
  });

  it('escapes the event name in the gallery', async () => {
    const ev = await createEvent('<script>alert(1)</script>');
    const html = await (await fetch(`${base}/g/${ev.id}/${ev.galleryKey}`)).text();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('deletes an event together with its photos', async () => {
    const ev = await createEvent('Delete test');
    const { id } = await (await upload({ 'X-Event-Id': ev.id, 'X-Event-Key': ev.setupKey })).json();
    expect((await fetch(`${base}/api/events/${ev.id}`, { method: 'DELETE', headers: admin })).status).toBe(200);
    expect((await fetch(`${base}/share/${id}.jpg`)).status).toBe(404);
    expect((await fetch(`${base}/api/events/${ev.id}`, { headers: admin })).status).toBe(404);
  });
});
