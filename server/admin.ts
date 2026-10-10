// The owner's /admin API: log in with the server's ADMIN_TOKEN plus a code
// from an authenticator app (TOTP), then manage every event.
//
// First login: token only → the server hands out a new TOTP secret (QR on
// the admin page) → the first valid code enrolls it. After that every login
// needs token + code. Lost the authenticator? Start the server once with
// ADMIN_TOTP_RESET=1 and enroll again.
//
// Sessions are a random cookie (HttpOnly, SameSite=Strict, 12 h); the
// database only stores its hash. Mutations only accept JSON, so a form on
// another site can't post here.

import { createHash, randomBytes } from 'node:crypto';
import { compEvent, EVENT_CURRENCY, EVENT_PRICE_CENTS, galleryLink, sendEventEmail, setupLink } from './billing.ts';
import { db, getSetting, setSetting } from './db.ts';
import { deleteEvent, eventStats, getEvent, listEvents, type StoredEvent, safeEqual, updateEvent } from './events.ts';
import { clientIp, HttpError, type Req, type Res, readJson, sendJson } from './http.ts';
import { countPhotos } from './photos.ts';
import { newSecret, otpauthUrl, verifyTotp } from './totp.ts';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const COOKIE = 'pb_admin';
const SESSION_HOURS = 12;
const MAX_FAILURES = 10; // per IP per window
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

if (process.env.ADMIN_TOTP_RESET === '1') {
  setSetting('totp_secret', null);
  setSetting('totp_pending', null);
  console.log('photoboot: admin TOTP reset — the next admin login enrolls a new authenticator.');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------- login throttling ----------

const failures = new Map<string, number[]>();

function tooManyFailures(ip: string): boolean {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= MAX_FAILURES;
}

function fail(ip: string): never {
  failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
  throw new HttpError(401, 'Wrong token or code.');
}

// ---------- sessions ----------

function cookieOf(req: Req): string | null {
  const m = String(req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

function isHttps(req: Req): boolean {
  return req.headers['x-forwarded-proto'] === 'https' || ('encrypted' in req.socket && !!req.socket.encrypted);
}

function startSession(req: Req, res: Res) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS * 3_600_000);
  db.prepare('DELETE FROM admin_sessions WHERE expires < ?').run(now.toISOString());
  db.prepare('INSERT INTO admin_sessions (token_hash, created, expires, ip) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    now.toISOString(),
    expires.toISOString(),
    clientIp(req)
  );
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_HOURS * 3600}`];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function loggedIn(req: Req): boolean {
  const token = cookieOf(req);
  if (!token) return false;
  const row = db.prepare('SELECT expires FROM admin_sessions WHERE token_hash = ?').get(sha256(token)) as
    | { expires: string }
    | undefined;
  return !!row && row.expires > new Date().toISOString();
}

function endSession(req: Req, res: Res) {
  const token = cookieOf(req);
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// ---------- views ----------

function eventView(ev: StoredEvent) {
  return {
    id: ev.id,
    name: ev.name,
    email: ev.email,
    eventDate: ev.eventDate,
    status: ev.status,
    paid: ev.paid,
    retentionDays: ev.retentionDays,
    source: ev.source,
    created: ev.created,
    updated: ev.updated,
    setupLink: setupLink(ev),
    galleryLink: galleryLink(ev),
  };
}

function paymentsOf(eventId?: string) {
  const sql = `SELECT id, event_id AS eventId, provider, ref, amount, currency, status, created FROM payments
    ${eventId ? 'WHERE event_id = ?' : ''} ORDER BY created DESC LIMIT 500`;
  return eventId ? db.prepare(sql).all(eventId) : db.prepare(sql).all();
}

// ---------- routes ----------

const EVENT = /^\/api\/admin\/events\/([\w-]+)(\/email)?$/;

function requireJson(req: Req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON.');
  }
}

// Returns true when it handled the request.
export async function adminRoutes(req: Req, res: Res, url: URL): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith('/api/admin/')) return false;
  if (!ADMIN_TOKEN) {
    sendJson(res, 503, { error: 'Admin is off: the server has no ADMIN_TOKEN.' });
    return true;
  }
  if (req.method !== 'GET') requireJson(req);

  if (pathname === '/api/admin/me' && req.method === 'GET') {
    sendJson(res, 200, { loggedIn: loggedIn(req), enrolled: !!getSetting('totp_secret') });
    return true;
  }

  if (pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const { token, code } = await readJson<{ token?: string; code?: string }>(req, 4096);
    if (!safeEqual(token, ADMIN_TOKEN)) fail(ip);
    const secret = getSetting('totp_secret');
    if (secret) {
      if (!verifyTotp(secret, String(code ?? ''))) fail(ip);
      startSession(req, res);
      sendJson(res, 200, { ok: true });
      return true;
    }
    // Not enrolled yet: a code confirms the pending secret; no code starts it.
    const pending = getSetting('totp_pending');
    if (pending && code) {
      if (!verifyTotp(pending, String(code))) fail(ip);
      setSetting('totp_secret', pending);
      setSetting('totp_pending', null);
      startSession(req, res);
      sendJson(res, 200, { ok: true, enrolled: true });
      return true;
    }
    const fresh = newSecret();
    setSetting('totp_pending', fresh);
    sendJson(res, 200, { enroll: { secret: fresh, url: otpauthUrl(fresh, url.hostname || 'admin') } });
    return true;
  }

  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    endSession(req, res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (!loggedIn(req)) {
    sendJson(res, 401, { error: 'Log in first.' });
    return true;
  }

  if (pathname === '/api/admin/events' && req.method === 'GET') {
    const events = listEvents({ q: url.searchParams.get('q') ?? '' }).map((ev) => ({
      ...eventView(ev),
      photos: ev.photos,
      stats: ev.stats,
    }));
    sendJson(res, 200, { events, price: { amount: EVENT_PRICE_CENTS, currency: EVENT_CURRENCY } });
    return true;
  }

  // Comp: create an event that's paid for, optionally emailing the links.
  if (pathname === '/api/admin/events' && req.method === 'POST') {
    const body = await readJson<{ name?: string; email?: string; eventDate?: string; sendEmail?: boolean }>(req, 8192);
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Give the event a name.');
    const email = String(body.email ?? '').trim() || null;
    if (body.sendEmail && !email) throw new HttpError(400, 'Add an email address to send the links to.');
    const ev = await compEvent({
      name,
      email: email ?? '',
      eventDate: body.eventDate || null,
      sendEmail: !!body.sendEmail,
    });
    sendJson(res, 201, { event: eventView(ev) });
    return true;
  }

  if (pathname === '/api/admin/payments' && req.method === 'GET') {
    sendJson(res, 200, { payments: paymentsOf() });
    return true;
  }

  const m = pathname.match(EVENT);
  if (m) {
    const ev = getEvent(m[1]);
    if (!ev) throw new HttpError(404, 'No such event.');
    if (m[2]) {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      await sendEventEmail(ev);
      sendJson(res, 200, { ok: true });
    } else if (req.method === 'GET') {
      sendJson(res, 200, {
        event: eventView(ev),
        photos: countPhotos(ev.id),
        stats: eventStats(ev.id),
        payments: paymentsOf(ev.id),
      });
    } else if (req.method === 'PATCH') {
      const body = await readJson<{ name?: string; email?: string; retentionDays?: number; paid?: boolean }>(req, 8192);
      const retentionDays = body.retentionDays === undefined ? undefined : Number(body.retentionDays);
      if (retentionDays !== undefined && !(Number.isInteger(retentionDays) && retentionDays >= 0)) {
        throw new HttpError(400, 'Retention is a whole number of days (0 = forever).');
      }
      updateEvent(ev.id, {
        name: body.name?.trim() || undefined,
        email: body.email === undefined ? undefined : body.email.trim() || null,
        retentionDays,
        paid: body.paid,
        status: body.paid ? 'active' : undefined,
      });
      sendJson(res, 200, { event: eventView(getEvent(ev.id) as StoredEvent) });
    } else if (req.method === 'DELETE') {
      await deleteEvent(ev.id);
      sendJson(res, 200, { ok: true });
    } else {
      throw new HttpError(405, 'Method not allowed.');
    }
    return true;
  }

  sendJson(res, 404, { error: 'Not found.' });
  return true;
}
