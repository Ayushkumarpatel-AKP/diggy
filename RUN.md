# Diggy — how to run everything

## 1. The extension (browser bot)
1. `chrome://extensions` / `brave://extensions` → **Developer mode ON** → **Load unpacked** →
   `apps/extension/.output/chrome-mv3` (or the copy in your Downloads).
   - After a rebuild, hit the **reload (↻)** button on the Diggy card.
2. Open a **real website** (not the New Tab page / `chrome://` pages).
3. The bot walks into the **bottom-left corner**. Press the toolbar icon → **side panel**.

### Tabs in the side panel
- **Chat** — typed chat + `Scan page`, `Fill form`, `My profile`. ⚙ opens settings.
- **Profile** — create/unlock your **encrypted** vault (AES-256-GCM + Argon2id, local only).
  Once unlocked, the decrypted profile (secrets stripped) feeds the `getProfile` tool.
- **Reminders** — create/list/snooze/complete deadlines; alarms fire even when the panel is closed.
- **Page** — what's running on the web right now: active tab, page scan, service status.

### Voice (push-to-talk)
**First time: open the side panel and click the 🎙 button once** (grants microphone access to the
extension — a browser permission prompt). Then:

Hold **`Ctrl+Shift+Space`** on any page → the bot shows **"Listening…"** → speak → release.
The recording is transcribed by **Groq Whisper** (`whisper-large-v3`) and the background runs the
brain; a **speech bubble above the avatar** shows the reply (truncated with `…` when long) and
**speaks it aloud**. Form fills appear as a **Fill / Cancel** bubble.
(The shortcut is configurable in ⚙ settings.)

> Voice works in **Chrome and Edge** — it does *not* rely on the browser's Web Speech service,
> which Edge/Chrome often block. It needs a **Groq API key** (already configured here).

## 2. Crawler / research service
```bash
pnpm --filter @diggy/crawler start        # http://127.0.0.1:17322
```
Endpoints: `/health`, `/providers`, `/extract`, `/crawl`, `/search?q=`, `/markdown`.
Optional providers (set env before starting) — Firecrawl `FIRECRAWL_API_KEY`,
Crawl4AI `CRAWL4AI_URL`, browser-use `BROWSER_USE_URL`. Without them the built-in
Playwright crawler + keyless DuckDuckGo search are used.

## 3. Desktop bridge (works today, no Rust needed)
```bash
set DIGGY_BRIDGE_TOKEN=my-secret           # Windows (bash: export ...)
pnpm --filter @diggy/bridge start          # ws://127.0.0.1:17321
```
Then in the extension ⚙ settings: paste the **token** → **Connect bridge** → the header badge
turns **"Desktop linked"**. The bridge relays `crawl` / `searchWeb` to the crawler service.

## 4. Desktop companion (Tauri — built & running)
Rust **is installed** (GNU toolchain: `stable-x86_64-pc-windows-gnu` — chosen because
VS/MSVC build tools are absent; the MSVC toolchain cannot link on this machine).
```bash
cd apps/desktop/src-tauri
~/.cargo/bin/cargo run          # builds (first run is slow) and launches
# or run the already-built debug binary:
./target/debug/diggy-desktop.exe
```
Verified: `cargo check` clean, `cargo build` succeeds, and the app launches
(`diggy-desktop.exe` + WebView2 windows). It shows a transparent, always-on-top
**overlay** window plus a `main` control window; `Ctrl+Shift+D` toggles the overlay
and `toggle_click_through` switches click-through. The Rust shell supervises the
Node bridge (`start_bridge` / `stop_bridge` / `bridge_status`).
Icons live in `src-tauri/icons/` (generated). For a polished app, replace them and
add a real frontend in `apps/desktop/src` (currently a minimal `dist/index.html`).

## 5. API keys
Keys live in `apps/extension/.env` (gitignored) and are baked into the build for local use.
Provider + model are configurable in ⚙ settings (Groq default: `openai/gpt-oss-120b`).

> **Do not publish a build made with `.env` present** — it embeds your keys. Rotate the keys
> from the Groq/NVIDIA dashboards and ship a key-less build for any public upload.

## 6. Google (Gmail + Calendar) — inbox & calendar watching

### Easiest: “Simple connect” (no setup at all)
Because you are already signed in to Gmail/Calendar **in this browser**, Diggy can use that
session directly. In **⚙ → Apps**:
- **Connect Gmail (no setup)** — reads your inbox via Google’s Atom feed with your cookies.
  Nothing to create, no client ID, no redirect URI. (Requires you to be signed in at mail.google.com.)
- **Calendar ICS URL** — in Google Calendar open **Settings → (your calendar) → “Secret address in iCal format”**,
  copy that URL, paste it in the Apps tab, **Save calendar URL**. Done.
Then turn on **Watch Gmail** / **Watch Calendar**. Diggy announces important mail
(offer / interview / selection / deadline → excited 🎉 ping, spoken by the avatar) and pings you
when an event is ~20 minutes away. Checks run every ~5 minutes.

### Advanced (optional): full Google APIs via OAuth
Only needed if you want Gmail search/history or to create calendar events:
1. Google Cloud Console → **Credentials → Create credentials → OAuth client ID → Web application**.
2. Enable the **Gmail API** and **Google Calendar API**.
3. Add the **Redirect URI** shown in the Apps tab (**Copy** button) to that client:
   `https://<your-extension-id>.chromiumapp.org/`
4. Paste the **Client ID** in the Apps tab → **Connect Google**.
OAuth takes priority when connected; otherwise the zero-setup session/ICS sources are used.

Either way, the bot gains `readInbox` / `readCalendar`, so you can just ask
“koi job wala email aaya kya?” or “kal kya hai mere schedule me?”.

## Verified end-to-end (this build)
- Extension: bot renders in the page corner, **push-to-talk** → background brain → bubble +
  speech + inline **Fill/Cancel**; form scan/fill works; **DESKTOP LINKED** bridge handshake.
- **Provider failover**: with Groq rate-limited (429) the panel automatically switched to
  **NVIDIA (openai/gpt-oss-20b)** and still answered — verified live.
- **Self-serve web**: asked for web info, the bot searched the web itself and answered
  ("official Rust site — https://www.rust-lang.org") instead of asking to open a tab.
- Brain: real Groq + NVIDIA calls verified (`openai/gpt-oss-120b` / `openai/gpt-oss-20b`).
- Crawler: Firecrawl / Crawl4AI / browser-use adapter **HTTP paths** exercised against local
  mock servers; **builtin Playwright** really crawled `example.com`; keyless **search** returns
  live DuckDuckGo results (fixed: DuckDuckGo needs a browser User-Agent).
- Desktop: `cargo build` + launch confirmed.
- `pnpm build` 9/9, `pnpm test` 9/9 (vault 23 · core 19 · crawler 42 · bridge 6).

## Notes on models
- Groq default `openai/gpt-oss-120b`; NVIDIA default `openai/gpt-oss-20b` (the old
  `meta/llama-3.3-70b-instruct` was retired on NVIDIA, and `llama-3.3-70b-versatile` on Groq).
- gpt-oss models run with `reasoning_effort: "low"` so the answer isn't swallowed by the
  reasoning preamble (also cuts token usage).
- If the active provider hits its limit, Diggy switches to the other one automatically for a
  few minutes, then tries the primary again.
