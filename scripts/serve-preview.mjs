/**
 * Serves the GUI preview over HTTP so it can be opened, and actually used, in a browser.
 *
 * Neither shipping front end is a web server: the terminal UI needs a TTY and the desktop
 * app is an Electron window. The renderer, though, is ordinary web code, so this serves
 * the self-contained preview page that `preview-gui.mjs` generates. Interactions work
 * here because it is a real page on a real origin, not a static snapshot.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serveDir = path.join(root, 'dist-gui', 'preview');
const port = Number(process.env.PORT ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (request, response) => {
  const requested = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const file = path.resolve(serveDir, relative);

  // Never serve outside the preview directory, whatever the request path claims.
  if (file !== serveDir && !file.startsWith(serveDir + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      // Always hand back the current build during development.
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(
      `Not found: ${relative}\n\nRun "npm run gui:preview" to generate the preview page.\n`,
    );
  }
});

server.listen(port, () => {
  process.stdout.write(`fastxdcc GUI preview: http://localhost:${port}\n`);
  process.stdout.write(`serving ${path.relative(root, serveDir)}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
