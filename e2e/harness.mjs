/**
 * Shared helpers for the Diggy e2e suite.
 *
 * The suite drives the *real built extension* in a persistent Chromium context.
 * Nothing here fails when a prerequisite is missing — callers `skip()` instead.
 */
import { extensionBuilt, launchExtension, extensionUrl, BUILD_HINT } from './extension.mjs';
import { loadPlaywright, PLAYWRIGHT_MISSING_HINT } from './playwright.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

export { BUILD_HINT, PLAYWRIGHT_MISSING_HINT, extensionUrl };

/** Throw this from a test to mark it skipped rather than failed. */
export class SkipError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipError';
    this.skip = true;
  }
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to let the background service worker finish `bootstrap()` before we
 * open a page.
 *
 * On a *fresh* profile the installer fires `onInstalled`, whose
 * `reinjectIntoOpenTabs()` injects the content script into every already-open
 * tab. WXT invalidates the older content-script instance the moment a newer one
 * starts in the same page, so a tab that is open *while* that reinjection runs
 * loses the bot. Waiting for bootstrap to settle sidesteps the race (see the
 * e2e README for the full note).
 */
export const SETTLE_MS = 3000;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Build the per-run environment handed to every test. */
export async function createEnv({ headed = false } = {}) {
  const playwright = await loadPlaywright();
  const built = extensionBuilt();
  const fixtures = await startFixtureServer();
  return {
    playwright,
    built,
    headed,
    fixtures,
    /** Launch the extension; throws SkipError when a prerequisite is missing. */
    async launch() {
      if (!playwright) throw new SkipError(PLAYWRIGHT_MISSING_HINT);
      if (!built) throw new SkipError(BUILD_HINT);
      const app = await launchExtension({ headed });
      await delay(SETTLE_MS);
      return app;
    },
    async dispose() {
      await fixtures.close();
    },
  };
}

/** Open a fixture page and wait until the in-page bot has mounted. */
export async function openBotPage(app, url) {
  const page = await app.context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#diggy-avatar-host', { state: 'attached', timeout: 20_000 });
  return page;
}

/** Open the built side panel and wait for its tab nav. */
export async function openPanel(app) {
  if (!app.extensionId) throw new Error('extension id not found (background service worker missing)');
  const page = await app.context.newPage();
  await page.goto(extensionUrl(app.extensionId, 'sidepanel.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav[aria-label="Diggy sections"]', { timeout: 15_000 });
  return page;
}

/** Read the mounted bot's shadow DOM in the main world (DOM is shared). */
export async function readBotShadow(page) {
  return page.evaluate(() => {
    const host = document.getElementById('diggy-avatar-host');
    const root = host ? host.shadowRoot : null;
    const say = root ? root.querySelector('.diggy-bubble__say') : null;
    return {
      host: Boolean(host),
      shadowRoot: Boolean(root),
      bubble: Boolean(root && root.querySelector('.diggy-bubble')),
      canvas: Boolean(root && root.querySelector('canvas')),
      sayText: say ? (say.textContent || '').trim() : '',
    };
  });
}

/** Wait until the in-page bubble shows text matching `pattern`. */
export async function waitForBubbleText(page, pattern, timeout = 60_000) {
  const source = pattern instanceof RegExp ? pattern.source : JSON.stringify(pattern);
  await page.waitForFunction(
    (re) => {
      const root = document.getElementById('diggy-avatar-host')?.shadowRoot;
      const say = root ? root.querySelector('.diggy-bubble__say') : null;
      if (!say) return false;
      return new RegExp(re).test(say.textContent || '');
    },
    source,
    { timeout },
  );
  return readBotShadow(page);
}
