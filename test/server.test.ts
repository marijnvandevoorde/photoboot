import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The real app on a random port, with photos and the database in a temp
// folder. The server modules read their env at import, so set it first.
let dir: string;
let server: Server;
let base: string;
let cleanup: () => Promise<number>;
let db: typeof import('../server/db.ts').db;
let billing: typeof import('../server/billing.ts');
let outbox: typeof import('../server/mail.ts').outbox;
let totp: typeof import('../server/totp.ts').totp;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'photoboot-test-'));
  process.env.SHARE_DIR = path.join(dir, 'shares');
  process.env.EVENTS_DIR = path.join(dir, 'events');
  process.env.ADMIN_TOKEN = 'test-admin';
  process.env.SHARE_TTL_DAYS = '30';
  process.env.PAID_RETENTION_DAYS = '365';
  process.env.PUBLIC_URL = 'https://booth.test';
  delete process.env.BASE_URL;
  delete process.env.BREVO_API_KEY;
  const { createApp } = await import('../server/index.ts');
  ({ cleanup } = await import('../server/photos.ts'));
  ({ db } = await import('../server/db.ts'));
  billing = await import('../server/billing.ts');
  ({ outbox } = await import('../server/mail.ts'));
  ({ totp } = await import('../server/totp.ts'));
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const json = { 'Content-Type': 'application/json' };

async function upload(headers: Record<string, string> = {}) {
  return fetch(`${base}/api/share`, {
    method: 'POST',
    body: JPEG,
    headers: { 'Content-Type': 'image/jpeg', ...headers },
  });
}

// ---------- admin session ----------

let cookie = '';

async function adminLogin(): Promise<string> {
  if (cookie) return cookie;
  // First login enrolls the authenticator: token alone returns the secret.
  const start = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ token: 'test-admin' }),
  });
  const { enroll } = await start.json();
  expect(enroll.url).toMatch(/^otpauth:\/\/totp\//);
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ token: 'test-admin', code: totp(enroll.secret) }),
  });
  expect(res.status).toBe(200);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  secret = enroll.secret;
  return cookie;
}
let secret = '';

async function admin(method: string, route: string, body?: unknown) {
  return fetch(`${base}/api/admin/${route}`, {
    method,
    headers: { Cookie: await adminLogin(), ...(method === 'GET' ? {} : json) },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
}

interface EventLinks {
  id: string;
  setupKey: string;
  galleryKey: string;
}

// A paid event made from /admin (a comp), with its keys parsed from the links.
async function createEvent(name = 'Party', email = 'host@example.com'): Promise<EventLinks> {
  const res = await admin('POST', 'events', { name, email, sendEmail: false });
  expect(res.status).toBe(201);
  const { event } = await res.json();
  const [, id, setupKey] = event.setupLink.match(/#event=([\w-]+)\.([\w-]+)$/);
  const galleryKey = event.galleryLink.split('/').pop();
  return { id, setupKey, galleryKey };
}

const boothHeaders = (ev: EventLinks) => ({ 'X-Event-Id': ev.id, 'X-Event-Key': ev.setupKey });

// ---------- sharing ----------

describe('sharing', () => {
  it('stores a JPEG and serves its page and image', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    const { id, url } = await res.json();
    expect(url).toBe(`${base}/s/${id}`);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/deleted automatically on \d{4}-\d{2}-\d{2} \(30 days/);

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

  it('expires free photos after 30 days and paid events after their retention', async () => {
    const ev = await createEvent('Retention');
    const old = (await (await upload()).json()).id;
    const fresh = (await (await upload()).json()).id;
    const oldPaid = (await (await upload(boothHeaders(ev))).json()).id;
    const setCreated = (id: string, iso: string) =>
      db.prepare('UPDATE photos SET created = ? WHERE id = ?').run(iso, id);
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    setCreated(old, daysAgo(31));
    setCreated(oldPaid, daysAgo(200)); // within the paid event's 365 days
    expect(await cleanup()).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${base}/share/${old}.jpg`)).status).toBe(404);
    expect((await fetch(`${base}/share/${fresh}.jpg`)).status).toBe(200);
    expect((await fetch(`${base}/share/${oldPaid}.jpg`)).status).toBe(200);
  });

  it('answers a malformed URL with 400 instead of crashing', async () => {
    expect((await fetch(`${base}/%E0`)).status).toBe(400);
    expect((await fetch(`${base}/`)).status).not.toBe(500); // still alive
  });
});

// ---------- CORS ----------

describe('CORS for the app', () => {
  it('answers the preflight for the app origin only', async () => {
    const ok = await fetch(`${base}/api/share`, {
      method: 'OPTIONS',
      headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    expect(ok.headers.get('access-control-allow-headers')).toContain('X-Event-Key');

    const other = await fetch(`${base}/api/share`, {
      method: 'POST',
      body: JPEG,
      headers: { Origin: 'https://evil.example' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('marks real API responses for the app', async () => {
    const res = await upload({ Origin: 'capacitor://localhost' });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
  });

  it('never opens /api/admin to the app origin', async () => {
    const res = await fetch(`${base}/api/admin/me`, { headers: { Origin: 'capacitor://localhost' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ---------- admin ----------

describe('admin', () => {
  it('needs a session', async () => {
    expect((await fetch(`${base}/api/admin/events`)).status).toBe(401);
  });

  it('enrolls an authenticator, then needs token + code', async () => {
    await adminLogin();
    const me = await (await fetch(`${base}/api/admin/me`, { headers: { Cookie: cookie } })).json();
    expect(me).toEqual({ loggedIn: true, enrolled: true });
    const noCode = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ token: 'test-admin' }),
    });
    expect(noCode.status).toBe(401); // enrolled: a code is required now
    const ok = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ token: 'test-admin', code: totp(secret) }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
  });

  it('refuses a wrong token, and non-JSON posts', async () => {
    const bad = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { ...json, 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ token: 'nope', code: '000000' }),
    });
    expect(bad.status).toBe(401);
    const form = await fetch(`${base}/api/admin/events`, {
      method: 'POST',
      headers: { Cookie: await adminLogin(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=x',
    });
    expect(form.status).toBe(415);
  });

  it('locks out an IP after repeated failures', async () => {
    const attempt = () =>
      fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { ...json, 'X-Forwarded-For': '198.51.100.7' },
        body: JSON.stringify({ token: 'nope' }),
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  it('lists, edits and deletes events', async () => {
    const ev = await createEvent('Listed party');
    const { events } = await (await admin('GET', 'events?q=Listed')).json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'Listed party',
      paid: true,
      status: 'active',
      source: 'comp',
      retentionDays: 365,
    });

    expect((await admin('PATCH', `events/${ev.id}`, { retentionDays: 0 })).status).toBe(200);
    expect((await (await admin('GET', `events/${ev.id}`)).json()).event.retentionDays).toBe(0);

    const { id } = await (await upload(boothHeaders(ev))).json();
    expect((await admin('DELETE', `events/${ev.id}`)).status).toBe(200);
    expect((await fetch(`${base}/share/${id}.jpg`)).status).toBe(404);
    expect((await admin('GET', `events/${ev.id}`)).status).toBe(404);
  });

  it('emails the links when giving an event away', async () => {
    const before = outbox.length;
    const res = await admin('POST', 'events', { name: 'Gift', email: 'gift@example.com', sendEmail: true });
    expect(res.status).toBe(201);
    const mail = outbox[before];
    expect(mail.to.email).toBe('gift@example.com');
    expect(mail.text).toContain('https://booth.test/settings.html#event=');
    expect(mail.text).toContain('https://booth.test/g/');
  });
});

// ---------- events ----------

describe('events', () => {
  it('hands the setup to booths with the setup key only, and lets them save it', async () => {
    const ev = await createEvent('Setup test');
    expect((await fetch(`${base}/api/events/${ev.id}`, { headers: { 'X-Event-Key': 'wrong' } })).status).toBe(401);
    const save = await fetch(`${base}/api/events/${ev.id}`, {
      method: 'PUT',
      headers: { ...json, 'X-Event-Key': ev.setupKey },
      body: JSON.stringify({ name: 'x', config: { copies: 2 }, images: { header: null, footer: null } }),
    });
    expect(save.status).toBe(200);
    const res = await fetch(`${base}/api/events/${ev.id}`, { headers: { 'X-Event-Key': ev.setupKey } });
    expect(await res.json()).toMatchObject({ id: ev.id, name: 'Setup test', config: { copies: 2 } });
  });

  it('tags uploads with the event and refuses a wrong key', async () => {
    const ev = await createEvent('Gallery test');
    const bad = await upload({ 'X-Event-Id': ev.id, 'X-Event-Key': 'wrong' });
    expect(bad.status).toBe(401);
    for (let i = 0; i < 2; i++) expect((await upload(boothHeaders(ev))).status).toBe(201);

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
      headers: { 'X-Event-Key': ev.setupKey, ...json },
      body: JSON.stringify({ device: 'booth-1', stats }),
    });

    const { events } = await (await admin('GET', 'events?q=Gallery test')).json();
    expect(events[0]).toMatchObject({ photos: 2, stats: { sessions: 5, booths: 1 } });

    const html = await (await fetch(`${base}/g/${ev.id}/${ev.galleryKey}`)).text();
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('busiest hour 21:00');
    expect(html).toContain('365 days');
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
});

// ---------- billing ----------

describe('billing', () => {
  it('keeps a pending event closed until it is paid, then activates it once', async () => {
    const ev = billing.createPendingEvent({ name: 'Pending', email: 'pay@example.com' }, 'stripe');
    const links = { id: ev.id, setupKey: ev.setupKey, galleryKey: ev.galleryKey };
    expect((await upload(boothHeaders(links))).status).toBe(401);
    expect((await fetch(`${base}/g/${ev.id}/${ev.galleryKey}`)).status).toBe(402);

    const before = outbox.length;
    const payment = { provider: 'stripe' as const, ref: 'cs_test_123', amount: 1900, currency: 'eur' };
    const active = await billing.activateEvent(ev.id, payment);
    expect(active).toMatchObject({ status: 'active', paid: true, retentionDays: 365 });
    await billing.activateEvent(ev.id, payment); // webhook retry
    expect(outbox.length).toBe(before + 1); // one email only
    expect((await upload(boothHeaders(links))).status).toBe(201);

    billing.refundPayment('cs_test_123');
    const { event } = await (await admin('GET', `events/${ev.id}`)).json();
    expect(event.paid).toBe(false);
  });

  it('validates what a host fills in', () => {
    expect(() => billing.checkEventRequest({ name: '', email: 'a@b.co' })).toThrow(/name/);
    expect(() => billing.checkEventRequest({ name: 'x', email: 'nope' })).toThrow(/email/);
    expect(billing.checkEventRequest({ name: ' Party ', email: 'A@B.co', eventDate: '2026-12-31' })).toEqual({
      name: 'Party',
      email: 'a@b.co',
      eventDate: '2026-12-31',
    });
  });
});
