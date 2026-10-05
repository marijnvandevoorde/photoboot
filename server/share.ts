// Photo sharing + event routes, as one Connect-style middleware used by the
// Vite dev server (vite.config.js) and the production server (index.js).
//
//   POST   /api/share          JPEG body → { id, url }  (url = the photo page)
//   GET    /s/{uuid}           photo page: view, download, delete
//   GET    /share/{uuid}.jpg   the photo itself
//   DELETE /api/share/{uuid}   delete (the unguessable id is the capability)
//   …and /api/events, /g/… from events.js.
//
// Uploads are limited per IP unless they carry a valid event key
// (X-Event-Id + X-Event-Key), refused when the disk quota is hit, and, if
// UPLOAD_TOKEN is set, need X-Upload-Token or an event key.
//
// Config (env): BASE_URL, UPLOAD_TOKEN, plus those in photos.js / events.js.

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { eventRoutes, verifyEventKey } from './events.ts';
import {
  baseUrl,
  clientIp,
  escapeHtml,
  HttpError,
  type Next,
  page,
  type Req,
  type Res,
  readBody,
  sendHtml,
  sendJson,
} from './http.ts';
import { deletePhoto, expiresAt, hasRoomFor, ID, jpgPath, photoMeta, savePhoto, TTL_DAYS } from './photos.ts';

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 120; // uploads per IP per hour without an event key

const recent = new Map<string, number[]>(); // ip → timestamps

// The iOS / Android app serves its pages from these origins and calls the
// API cross-origin. Every API route still needs its own key or token.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'capacitor://localhost,https://localhost')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Adds CORS headers for the app; returns true when it answered a preflight.
function cors(req: Req, res: Res, pathname: string): boolean {
  const origin = req.headers.origin;
  if (!origin || !CORS_ORIGINS.includes(origin) || !pathname.startsWith('/api/')) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Event-Id, X-Event-Key, X-Upload-Token',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
  return true;
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 10_000) recent.clear(); // crude bound on memory
  return hits.length > RATE_MAX;
}

async function upload(req: Req, res: Res): Promise<void> {
  const event = req.headers['x-event-id']
    ? await verifyEventKey(req.headers['x-event-id'], req.headers['x-event-key'])
    : null;
  if (req.headers['x-event-id'] && !event) return sendJson(res, 401, { error: 'Unknown event or wrong event key.' });
  if (!event && UPLOAD_TOKEN && req.headers['x-upload-token'] !== UPLOAD_TOKEN) {
    return sendJson(res, 401, { error: 'Upload token required.' });
  }
  if (!event && rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many uploads, try again later.' });

  const body = await readBody(req, MAX_PHOTO_BYTES);
  // JPEG files start with FF D8 FF.
  if (body.length < 3 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) {
    return sendJson(res, 400, { error: 'Expected a JPEG body.' });
  }
  if (!(await hasRoomFor(body.length))) return sendJson(res, 507, { error: 'The photo server is full.' });
  const id = randomUUID();
  await savePhoto(id, body, event?.id ?? null);
  sendJson(res, 201, { id, url: `${baseUrl(req)}/s/${id}` });
}

async function serveJpg(id: string, res: Res): Promise<void> {
  try {
    const { size } = await stat(jpgPath(id));
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': size,
      // Private: no CDN copy that outlives a delete or the expiry.
      'Cache-Control': 'private, max-age=3600',
      'X-Robots-Tag': 'noindex',
    });
    createReadStream(jpgPath(id)).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function sharePage(id: string, res: Res): Promise<void> {
  const meta = await photoMeta(id);
  if (!meta) {
    return sendHtml(
      res,
      404,
      page('Photo not found', '<h1>This photo is gone</h1><p class="muted">It was deleted, or it expired.</p>')
    );
  }
  const expires = expiresAt(meta.created);
  const expiryText = expires
    ? `This photo is deleted automatically on ${expires.toISOString().slice(0, 10)} (${TTL_DAYS} days after it was taken).`
    : '';
  sendHtml(
    res,
    200,
    page(
      'Your photo',
      `<h1>Your photo 📸</h1>
<img class="photo" src="/share/${id}.jpg" alt="Your photo booth photo">
<div class="actions">
  <a class="btn" href="/share/${id}.jpg" download="photobooth.jpg">Save photo</a>
  <button class="btn secondary" id="delete">Delete from the server</button>
</div>
<p class="muted">${escapeHtml(expiryText)} Anyone with this link can see it, so only share it with people you trust.</p>
<script>
  document.getElementById('delete').addEventListener('click', async () => {
    if (!confirm('Delete this photo from the server for good?')) return;
    const res = await fetch('/api/share/${id}', { method: 'DELETE' });
    document.querySelector('main').innerHTML = res.ok
      ? '<h1>Deleted</h1><p class="muted">The photo is gone from the server.</p>'
      : '<h1>Something went wrong</h1><p class="muted">Please try again.</p>';
  });
</script>`
    )
  );
}

const SHARE_JPG = /^\/share\/([0-9a-f-]{36})\.jpg$/;
const SHARE_PAGE = /^\/s\/([0-9a-f-]{36})$/;
const SHARE_API = /^\/api\/share\/([0-9a-f-]{36})$/;

async function route(req: Req, res: Res, next: Next): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const { pathname } = url;
  if (cors(req, res, pathname)) return;
  if (pathname === '/api/share' && req.method === 'POST') return upload(req, res);

  // The photo id from `pattern`, if this request is `method` on it.
  const photoId = (method: string, pattern: RegExp) => {
    const id = req.method === method ? pathname.match(pattern)?.[1] : undefined;
    return id && ID.test(id) ? id : null;
  };
  let id = photoId('GET', SHARE_JPG);
  if (id) return serveJpg(id, res);
  id = photoId('GET', SHARE_PAGE);
  if (id) return sharePage(id, res);
  id = photoId('DELETE', SHARE_API);
  if (id) {
    await deletePhoto(id);
    return sendJson(res, 200, { ok: true });
  }
  if (await eventRoutes(req, res, url)) return;
  next();
}

export function shareMiddleware(req: Req, res: Res, next: Next): void {
  route(req, res, next).catch((err: unknown) => {
    const known = err instanceof HttpError;
    if (!res.headersSent) sendJson(res, known ? err.status : 500, { error: known ? err.message : 'Server error.' });
    else res.end();
    if (!known) console.error(err);
  });
}
