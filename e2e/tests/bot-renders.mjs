/**
 * Test 1 — the in-page bot renders.
 *
 * Opens a local fixture page with the real extension loaded and asserts the
 * content script mounted `#diggy-avatar-host` with an open shadow root that
 * contains the `.diggy-bubble` wrapper and a `canvas` (the three.js avatar).
 */
import { assert, openBotPage, readBotShadow } from '../harness.mjs';

export const name = 'bot-renders';
export const description = 'the in-page bot mounts a shadow root with .diggy-bubble + canvas';

export async function run(env) {
  const app = await env.launch();
  try {
    const page = await openBotPage(app, env.fixtures.fixtureUrl('simple-page'));

    // The bubble + canvas are rendered by React/three.js after mount; wait for both.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('diggy-avatar-host')?.shadowRoot;
        return Boolean(root && root.querySelector('.diggy-bubble') && root.querySelector('canvas'));
      },
      undefined,
      { timeout: 20_000 },
    );

    const state = await readBotShadow(page);
    assert(state.host, '#diggy-avatar-host must exist in the page DOM');
    assert(state.shadowRoot, '#diggy-avatar-host must expose an open shadow root');
    assert(state.bubble, 'shadow root must contain .diggy-bubble');
    assert(state.canvas, 'shadow root must contain a <canvas> for the avatar');

    const dimensions = await page.evaluate(() => {
      const canvas = document.getElementById('diggy-avatar-host')?.shadowRoot?.querySelector('canvas');
      return canvas ? { w: canvas.width, h: canvas.height } : null;
    });
    assert(dimensions && dimensions.w > 0 && dimensions.h > 0, 'avatar canvas must have a non-zero size');

    return `host + shadow root + .diggy-bubble + canvas (${dimensions.w}x${dimensions.h}) on ${page.url()}`;
  } finally {
    await app.close();
  }
}
