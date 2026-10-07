# Diggy e2e — the real extension in Chromium

Playwright (`playwright-core`, reused from `services/crawler` — **no new
dependency**) drives the *built* extension loaded with
`chromium.launchPersistentContext`.

```bash
pnpm --filter @diggy/extension build      # → apps/extension/.output/chrome-mv3
node e2e/run.mjs                          # all tests
node e2e/run.mjs --test=bot-renders       # one test
node e2e/run.mjs --list                   # list tests
node e2e/run.mjs --headed                 # watch it happen
```

Every test is individually runnable and **skips cleanly** (never fails) when a
prerequisite is missing:

- extension not built → skip with
  `run the extension build first: pnpm --filter @diggy/extension build`;
- `playwright-core` unresolvable → skip with the install hint.

## Tests

| Name | What it proves |
|---|---|
| `bot-renders` | `#diggy-avatar-host` mounts with an open shadow root containing `.diggy-bubble`; clicking the bubble's "Show Diggy" toggle expands it and mounts a non-zero `<canvas>` (the three.js/VRM avatar). |
| `sidepanel-opens` | `sidepanel.html` renders its section nav (7 tabs) and the **Plugins** tab shows the one-click plugin gallery with inline brand icons. |
| `form-fill-confirm` | Panel "Fill form" → **Confirm fill** plan → "Fill" → the page's inputs gain values and the form is **not submitted** (`submitCount === 0`). |
| `reminder-fires` | A ~3 s reminder (created through the panel's own storage + `diggy:reminder-schedule` message) fires into the in-page bubble; the reminder flips to `done`. |
| `video-card` | A `kind:'video'` `RichCard` renders a thumbnail whose `src` contains `ytimg.com`, plus the ▶ overlay (network stubbed). |

## How the extension is launched

```js
chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium',                       // new headless mode — the headless
                                             // *shell* cannot load extensions
  args: [`--load-extension=<build>`,
         '--use-fake-ui-for-media-stream',
         '--use-fake-device-for-media-stream', ...],
  ignoreDefaultArgs: ['--disable-extensions'],   // Playwright disables them by default
});
```

The extension id is read from the MV3 background **service worker** URL, so tests
open `chrome-extension://<id>/sidepanel.html` without hardcoding it (the manifest
pins a `key`, so the id is stable anyway).

## Why `SETTLE_MS` (3 s) before opening a page

On a fresh profile Chromium fires `chrome.runtime.onInstalled`, and
`background.ts` responds with `reinjectIntoOpenTabs()` — it runs
`chrome.scripting.executeScript` for the content script in every open http(s)
tab. WXT's content-script runtime invalidates an older instance the moment a
newer one starts in the same page (`wxt:content-script-started`), and the
re-injected instance then returns early because the "already mounted" flag is
still set — so a tab that is open while that reinjection runs ends up **without**
the bot. Waiting for `bootstrap()` to settle before opening the fixture page
avoids the race entirely (the product's real-world path — install, *then* browse
— does not hit it).

## Fixtures

`e2e/fixtures/server.mjs` is a zero-dependency `node:http` server (shared with
`evals/`). It serves the pages in `e2e/fixtures/pages/`:

`simple-page` · `form` · `video-page` · `inbox` ·
`injection-email` · `injection-secrets` · `injection-form` · `reminder`

`form` is the important one: it records submit events on `window.__diggySubmitted`
/ `window.__diggySubmitCount`, which is how the suite proves "never submits".

Override the extension directory with `DIGGY_E2E_EXTENSION_DIR` if your build
output lives elsewhere.
