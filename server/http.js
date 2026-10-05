// Small HTTP helpers shared by the share and event routes.

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

export async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes) {
  try {
    return JSON.parse((await readBody(req, maxBytes)).toString('utf8'));
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error('Expected a JSON body.'), { status: 400 });
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Real client IP behind Cloudflare → Traefik.
export function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

export function baseUrl(req) {
  const fixed = (process.env.BASE_URL || '').replace(/\/+$/, '');
  if (fixed) return fixed;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  // HTTP/2 (Vite's HTTPS dev server) sends the host as :authority.
  const host = req.headers['x-forwarded-host'] || req.headers[':authority'] || req.headers.host;
  return `${proto}://${host}`;
}

// Page shell for the public share / gallery pages: light and dark, phone first.
export function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #111; --muted: #666; --card: #fff; --accent: #1f9e6e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f0f10; --fg: #f3f3f4; --muted: #9a9a9a; --card: #1a1a1c; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 56rem; margin: 0 auto; padding: 1.2rem 1rem 3rem; display: grid; gap: 1rem; }
  h1 { margin: 0; font-size: 1.5rem; }
  .muted { color: var(--muted); }
  .photo { width: 100%; height: auto; border-radius: 12px; background: var(--card); display: block; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .btn { appearance: none; border: 0; font: inherit; font-weight: 600; padding: 0.8rem 1.4rem; border-radius: 999px;
         background: var(--accent); color: #000; text-decoration: none; cursor: pointer; }
  .btn.secondary { background: var(--card); color: var(--fg); box-shadow: inset 0 0 0 1px #8885; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: 0.6rem; }
  .grid img { width: 100%; aspect-ratio: 3 / 4; object-fit: cover; border-radius: 8px; display: block; background: var(--card); }
  p { margin: 0; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
