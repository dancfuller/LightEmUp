// Read-only preview server for the LightEmUp frontend.
//
// The frontend calls same-origin `/api`, so to see *working-tree* frontend
// changes rendered against *real* data, we serve the local static files AND
// proxy GET /api + /events (SSE) to the Pi (the server of record). Any non-GET
// /api call is stubbed with a success — a preview must never mutate the Pi
// (the frontend's optimistic UI still reflects the change locally, which is all
// a screenshot needs).
//
//   PI=http://lightemup:8420 PORT=8421 node serve.mjs
//
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.PI || 'http://lightemup:8420';
const STATIC_DIR = process.env.STATIC_DIR || join(__dir, '..', '..', 'backend', 'static');
const PORT = Number(process.env.PORT || 8421);
const t = new URL(TARGET);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon', '.map': 'application/json',
};

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  // Never write to the server of record from a preview.
  if (url.startsWith('/api') && req.method !== 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"success":true,"ok":true,"preview_readonly":true}');
    return;
  }
  // Proxy GET /api + SSE to the Pi (streamed so SSE keeps working).
  if (url.startsWith('/api') || url === '/events') {
    const preq = http.request({
      hostname: t.hostname, port: t.port, path: url, method: req.method,
      headers: { ...req.headers, host: t.host },
    }, (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); });
    preq.on('error', (e) => { res.writeHead(502); res.end('proxy error: ' + e.message); });
    req.pipe(preq);
    return;
  }
  // Static from the working tree.
  let p = url.split('?')[0];
  if (p === '/') p = '/index.html';
  const filePath = join(STATIC_DIR, p.replace(/\.\.+/g, ''));
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found: ' + p);
  }
});
server.listen(PORT, () => console.log(`preview http://localhost:${PORT} -> ${TARGET} (static: ${STATIC_DIR})`));
