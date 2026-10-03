// Photo sharing: POST /api/share stores a JPEG under a random UUID and returns
// the public URL; GET /share/{uuid}.jpg serves it back. Used both by the Vite
// dev server (vite.config.js) and the production server (server/index.js).
//
// Config (env):
//   SHARE_DIR  where photos are stored (default ./shares)
//   BASE_URL   public origin used in the returned URL / QR code, e.g.
//              https://booth.example.com. If unset, derived from the request.

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SHARE_DIR = path.resolve(process.env.SHARE_DIR || 'shares');
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const MAX_BYTES = 15 * 1024 * 1024;
const SHARE_PATH = /^\/share\/([0-9a-f-]{36})\.jpg$/;

function baseUrl(req) {
  if (BASE_URL) return BASE_URL;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  // HTTP/2 (Vite's HTTPS dev server) sends the host as :authority.
  const host = req.headers['x-forwarded-host'] || req.headers[':authority'] || req.headers.host;
  return `${proto}://${host}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Object.assign(new Error('Photo too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function upload(req, res) {
  const body = await readBody(req);
  // JPEG files start with FF D8 FF.
  if (body.length < 3 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) {
    return sendJson(res, 400, { error: 'Expected a JPEG body.' });
  }
  const id = randomUUID();
  await mkdir(SHARE_DIR, { recursive: true });
  await writeFile(path.join(SHARE_DIR, `${id}.jpg`), body);
  sendJson(res, 201, { id, url: `${baseUrl(req)}/share/${id}.jpg` });
}

async function serve(id, res) {
  const file = path.join(SHARE_DIR, `${id}.jpg`);
  try {
    const { size } = await stat(file);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// Connect-style middleware: handles share routes, passes everything else on.
export function shareMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/share' && req.method === 'POST') {
    upload(req, res).catch((err) => sendJson(res, err.status || 500, { error: err.message }));
    return;
  }
  const match = req.method === 'GET' && url.pathname.match(SHARE_PATH);
  if (match) {
    serve(match[1], res);
    return;
  }
  next();
}
