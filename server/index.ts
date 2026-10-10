// Production server: serves the built app from ./dist plus the share routes.
// Plain HTTP; put it behind a TLS-terminating reverse proxy (camera and
// Web Bluetooth both require HTTPS).
//
//   PORT=8080 BASE_URL=https://booth.example.com SHARE_DIR=/data/shares node server/index.ts

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Req, Res } from './http.ts';
import { shareMiddleware } from './share.ts';

const PORT = Number(process.env.PORT || 8080);
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req: Req, res: Res): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    // Malformed escapes (e.g. /%E0) used to throw here and, unhandled, kill the process.
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  if (pathname === '/admin') pathname = '/admin.html';
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

// The whole app as a Node HTTP server (not listening yet), for tests too.
export function createApp(): Server {
  return createServer((req, res) =>
    shareMiddleware(req, res, () => {
      serveStatic(req, res).catch((err: unknown) => {
        console.error(err);
        if (!res.headersSent) res.writeHead(500).end();
      });
    })
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, () => {
    console.log(`photoboot listening on :${PORT}`);
  });
}
