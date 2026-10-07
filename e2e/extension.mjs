/**
 * Launch helpers: the real built extension inside a persistent Chromium context.
 *
 * Everything here degrades gracefully — if the extension is not built, or
 * Playwright/browsers are missing, the callers skip instead of failing.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, loadPlaywright, PLAYWRIGHT_MISSING_HINT } from './playwright.mjs';

/** Where `wxt build` writes the unpacked MV3 extension. */
export const EXTENSION_DIR = path.join(repoRoot, 'apps', 'extension', '.output', 'chrome-mv3');

/** The extension directory to load — overridable for other build locations. */
export function extensionDir() {
  return process.env.DIGGY_E2E_EXTENSION_DIR || EXTENSION_DIR;
}

export const BUILD_HINT =
  'Extension build output not found at apps/extension/.output/chrome-mv3 — ' +
  'run the extension build first: `pnpm --filter @diggy/extension build`';

/** True when the built extension manifest is present. */
export function extensionBuilt() {
  return existsSync(path.join(extensionDir(), 'manifest.json'));
}

function extensionArgs() {
  return [
    `--load-extension=${extensionDir()}`,
    // Fake a microphone so the offscreen recorder path can initialise headlessly.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/** Wait for the MV3 background service worker and read the extension id from it. */
async function extensionIdFrom(context) {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  }
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url());
  return match ? match[1] : undefined;
}

/**
 * Launch the extension in a persistent context.
 *
 * @param {{ headed?: boolean, args?: string[] }} [options]
 * @returns {Promise<{ context, extensionId, userDataDir, close(): Promise<void> }>}
 */
export async function launchExtension(options = {}) {
  const playwright = await loadPlaywright();
  if (!playwright) throw new Error(PLAYWRIGHT_MISSING_HINT);
  if (!extensionBuilt()) throw new Error(BUILD_HINT);

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'diggy-e2e-'));
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: !options.headed,
    // `channel: 'chromium'` selects Chromium's new headless mode — the headless
    // *shell* (Playwright's default headless build) cannot load extensions.
    channel: options.headed ? undefined : 'chromium',
    args: [...extensionArgs(), ...(options.args ?? [])],
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  let extensionId;
  try {
    extensionId = await extensionIdFrom(context);
  } catch {
    extensionId = undefined;
  }

  return {
    context,
    extensionId,
    userDataDir,
    async close() {
      await context.close().catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** URL of a built extension page (side panel, etc.). */
export function extensionUrl(extensionId, page = 'sidepanel.html') {
  return `chrome-extension://${extensionId}/${page}`;
}
