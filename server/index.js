// Production server: serves the built app from ./dist plus the share routes.
// Plain HTTP; put it behind a TLS-terminating reverse proxy (camera and
// Web Bluetooth both require HTTPS).
//
//   PORT=8080 BASE_URL=https://booth.example.com SHARE_DIR=/data/shares node server/index.js

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shareMiddleware } from './share.js';

const PORT = Number(process.env.PORT || 8080);
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(DIST, path.normalize(pathname));
  if (!file.startsWith(DIST + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

createServer((req, res) => shareMiddleware(req, res, () => serveStatic(req, res))).listen(PORT, () => {
  console.log(`photoboot listening on :${PORT}`);
});
