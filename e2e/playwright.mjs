/**
 * Resolve the Playwright module without adding a dependency.
 *
 * `services/crawler` already depends on `playwright-core`, so we reuse that
 * copy (resolved through the crawler package's `node_modules`) instead of
 * declaring our own. Nothing is installed here and no network is touched.
 *
 * `playwright-core` (not the `@playwright/test` runner) is all the suite needs:
 * `chromium.launchPersistentContext` plus a small hand-rolled test runner.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');

let cached; // undefined = not tried yet, null = unavailable

async function attempt(loader) {
  try {
    const mod = await loader();
    return mod?.chromium ? mod : null;
  } catch {
    return null;
  }
}

/** Load playwright-core (or playwright) — or return `null` when unavailable. */
export async function loadPlaywright() {
  if (cached !== undefined) return cached;

  const direct = await attempt(() => import('playwright-core'));
  if (direct) {
    cached = direct;
    return cached;
  }

  // Resolve through another workspace package that already depends on it.
  for (const rel of ['services/crawler/package.json', 'apps/extension/package.json', 'package.json']) {
    const mod = await attempt(async () => {
      const require = createRequire(path.join(repoRoot, rel));
      const resolved = require.resolve('playwright-core');
      return import(pathToFileURL(resolved).href);
    });
    if (mod) {
      cached = mod;
      return cached;
    }
  }

  cached = null;
  return cached;
}

export const PLAYWRIGHT_MISSING_HINT =
  'playwright-core could not be resolved. It ships as a dependency of @diggy/crawler — ' +
  'run `pnpm install` once so services/crawler/node_modules/playwright-core exists.';
