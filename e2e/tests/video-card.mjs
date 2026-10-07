/**
 * Test 5 — a `RichCard` with `kind:'video'` renders a thumbnail from ytimg.com.
 *
 * The network is stubbed (no real YouTube call):
 *   - `panel.addInitScript` patches the panel page's `fetch` so the channel
 *     page and the Atom feed return canned data, and
 *   - the page intercepts the thumbnail request so the real
 *     `i.ytimg.com/...` <img> loads instead of erroring out (CardView hides a
 *     broken image, which would remove the very element we assert on).
 *
 * Then we type the video request into the panel's chat input and assert the
 * rendered video card.
 */
import { assert, openPanel } from '../harness.mjs';

export const name = 'video-card';
export const description = "a kind:'video' RichCard renders a ytimg.com thumbnail";

const VIDEO_ID = 'dQw4w9WgXcQ';
const CHANNEL_ID = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
const THUMBNAIL = `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`;

// 1x1 transparent PNG so the <img> resolves and stays in the DOM.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <yt:videoId>${VIDEO_ID}</yt:videoId>
    <title>Fake channel latest upload</title>
    <published>2025-02-20T12:00:00+00:00</published>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${VIDEO_ID}"/>
  </entry>
</feed>`;

const CHANNEL_HTML = `<!doctype html><html><head>
<meta itemprop="channelId" content="${CHANNEL_ID}">
<title>Fake Channel</title></head><body><h1>Fake Channel</h1></body></html>`;

export async function run(env) {
  const app = await env.launch();
  try {
    const panel = await openPanel(app);

    // Stub the panel's fetch (the video resolver runs inside the panel page).
    await panel.addInitScript(
      ({ feed, channel }) => {
        const realFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
          if (url.includes('youtube.com/feeds/videos.xml')) {
            return new Response(feed, { status: 200, headers: { 'content-type': 'application/xml' } });
          }
          if (url.includes('youtube.com/')) {
            return new Response(channel, { status: 200, headers: { 'content-type': 'text/html' } });
          }
          return realFetch(input, init);
        };
      },
      { feed: FEED_XML, channel: CHANNEL_HTML },
    );
    // Reload so the init script takes effect, then wait for the nav again.
    await panel.reload({ waitUntil: 'domcontentloaded' });
    await panel.waitForSelector('nav[aria-label="Diggy sections"]', { timeout: 15_000 });

    // Let the thumbnail load (otherwise CardView hides the broken <img>).
    await panel.route(/ytimg\.com/, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG_1x1, 'base64') }),
    );

    // Drive the real chat path.
    const input = panel.locator('input[placeholder^="Ask Diggy"]');
    await input.fill('MrBeast ka latest video');
    await input.press('Enter');

    // The video card's thumbnail.
    const thumb = panel.locator(`img[src*="ytimg.com"]`);
    await thumb.first().waitFor({ timeout: 20_000 });
    const src = await thumb.first().getAttribute('src');
    assert(src && src.includes('ytimg.com'), `thumbnail src must contain ytimg.com (got ${src})`);

    // kind:'video' also draws the ▶ overlay.
    const hasPlayGlyph = await panel.evaluate(() => {
      return Array.from(document.querySelectorAll('span')).some((s) => (s.textContent || '').trim() === '▶');
    });
    assert(hasPlayGlyph, "a kind:'video' card must render the ▶ overlay");

    // And the copy that accompanies it.
    const text = await panel.evaluate(() => document.body.innerText);
    assert(/latest video/i.test(text), 'the reply text should reference the latest video');

    return `video card thumbnail src=${src}; ▶ overlay present`;
  } finally {
    await app.close();
  }
}
