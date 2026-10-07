/**
 * Tiny zero-dependency HTTP fixture server for the Diggy e2e suite and the
 * agent evals harness.
 *
 * Serves the static fixture pages in `./pages/` and exposes a couple of
 * bookkeeping routes. `node:http` only — no dependencies, nothing on the network.
 *
 *   GET  /health                 -> { ok: true }
 *   GET  /fixtures/<name>[.html] -> a fixture page from ./pages/
 *   POST /__canary               -> records an "outward action" probe (JSON body)
 *   GET  /__canary               -> { actions: [...] }
 *
 * Usage:
 *   import { startFixtureServer } from './e2e/fixtures/server.mjs';
 *   const fixtures = await startFixtureServer();      // ephemeral port
 *   fixtures.baseUrl;                                 // http://127.0.0.1:<port>
 *   await fixtures.close();
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/** Trim, drop `..` traversal and any leading slash. */
function safeName(raw) {
  const clean = String(raw || '')
    .split('?')[0]
    .split('#')[0]
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return '';
  return clean;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

/**
 * Start the fixture server.
 * @param {{ port?: number, pagesDir?: string }} [options]
 */
export async function startFixtureServer(options = {}) {
  const pagesDir = options.pagesDir ?? PAGES_DIR;
  const actions = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname;

    if (req.method === 'GET' && (route === '/health' || route === '/')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'diggy-fixtures' }));
      return;
    }

    if (route === '/__canary') {
      if (req.method === 'POST') {
        const raw = await readBody(req);
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : null;
        } catch {
          payload = raw;
        }
        const entry = { at: new Date().toISOString(), payload };
        actions.push(entry);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, recorded: actions.length }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ actions }));
      return;
    }

    if (req.method === 'GET' && route.startsWith('/fixtures/')) {
      let name = safeName(route.slice('/fixtures/'.length));
      if (!name) {
        res.writeHead(400).end('bad fixture name');
        return;
      }
      if (!path.extname(name)) name = `${name}.html`;
      const full = path.join(pagesDir, name);
      if (!full.startsWith(pagesDir)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      try {
        const body = await readFile(full);
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(full)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`fixture not found: ${name}`);
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    /** Fixture page URL for a bare name (e.g. "form" -> ".../fixtures/form.html"). */
    fixtureUrl(name) {
      const file = /\.\w+$/.test(name) ? name : `${name}.html`;
      return `http://127.0.0.1:${port}/fixtures/${file}`;
    },
    actions,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export default startFixtureServer;
