/**
 * Test 1 — the in-page bot renders.
 *
 * Opens a local fixture page with the real extension loaded and asserts the
 * content script mounted `#diggy-avatar-host` with an open shadow root, the
 * `.diggy-bubble` wrapper, and — once the bubble is expanded — a `canvas` (the
 * three.js avatar, which loads `AvatarSample_I.vrm`).
 *
 * NOTE: the shipped bubble starts COLLAPSED (`data-visible="false"`, a 36px
 * "◕ Show Diggy" button). The avatar canvas and the 17 MB VRM are only created
 * when it is expanded, so the test clicks the toggle first. This was the one
 * behavioural assumption the first real run of this suite got wrong — the
 * product changed to a collapsed-by-default bubble; the engine is lazily built.
 */
import { assert, openBotPage, readBotShadow } from '../harness.mjs';

export const name = 'bot-renders';
export const description = 'the in-page bot mounts a shadow root; expanding it renders .diggy-bubble + canvas';

export async function run(env) {
  const app = await env.launch();
  try {
    const page = await openBotPage(app, env.fixtures.fixtureUrl('simple-page'));

    // The host + shadow root + collapsed bubble mount first.
    await page.waitForFunction(
      () => Boolean(document.getElementById('diggy-avatar-host')?.shadowRoot?.querySelector('.diggy-bubble')),
      undefined,
      { timeout: 20_000 },
    );

    // Expand the bubble ("Show Diggy"). Only then does the avatar engine mount
    // its <canvas> and fetch the VRM.
    await page.waitForFunction(
      () => Boolean(document.getElementById('diggy-avatar-host')?.shadowRoot?.querySelector('.diggy-bubble__toggle')),
      undefined,
      { timeout: 20_000 },
    );
    await page.evaluate(() => {
      document.getElementById('diggy-avatar-host').shadowRoot.querySelector('.diggy-bubble__toggle').click();
    });

    // The bubble + canvas are rendered by React/three.js after expanding; wait for both.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('diggy-avatar-host')?.shadowRoot;
        return Boolean(root && root.querySelector('.diggy-bubble') && root.querySelector('canvas'));
      },
      undefined,
      { timeout: 30_000 },
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

    return `host + shadow root + .diggy-bubble + canvas (${dimensions.w}x${dimensions.h}) after expanding on ${page.url()}`;
  } finally {
    await app.close();
  }
}
