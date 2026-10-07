# Diggy — Technical Project Dossier

> Everything about this project in one file: the stack, how each piece is wired, what is finished,
> what is partial, and what is knowingly weak. Status notes say **how** each claim was verified,
> because "it builds" and "I watched it work" are different claims.

Last updated: 2026-10-07 · Branch `main` · `pnpm` monorepo, TypeScript end to end.

---

## 1. What Diggy is

A **browser-resident animated companion** (a small VRM avatar) that actually *does* things on the web:

- lives in the corner of every page, walks in, idles, emotes, speaks;
- holds a **push-to-talk conversation** (Whisper transcription → LLM with tools);
- **reads the web itself** (search, crawl, transcripts) and **reads sites you are signed into**;
- **fills forms** from an encrypted local profile and **never submits**;
- manages **reminders** and **watches** pages/mail for things you care about;
- connects to third-party services (Gmail, Calendar, Notion, GitHub) through a **local plugin backend**.

Two companion runtimes exist beyond the extension: a **desktop overlay** (Tauri) and a set of **local
services** (crawler, bridge, plugin API).

---

## 2. Monorepo map

```
diggy/
├─ apps/
│  ├─ extension/     WXT (Manifest V3) — the product. Content script, side panel, offscreen mic, overlay.
│  ├─ desktop/       Tauri v2 shell — transparent always-on-top overlay + Rust bridge supervisor.
│  └─ demo/          Vite playground — the animation gallery used to review/curate clips.
├─ packages/
│  ├─ shared/        Types + the extension⇄desktop protocol. No runtime deps.
│  ├─ avatar/        three.js + three-vrm engine: idle, walk, clips, staging, framing, particles.
│  ├─ core/          The brain: providers, tool-calling orchestrator, persona, errors, config.
│  ├─ vault/         Argon2id + AES-256-GCM encrypted profile store with auto-lock.
│  └─ ui/            Pen-sketch design system (rough.js + Tailwind preset) + official brand icons.
├─ services/
│  ├─ crawler/       Fastify: /extract /crawl /search /markdown /transcript /feed /reach
│  ├─ api/           Fastify + SQLite: Google sign-in, OAuth plugins, encrypted token vault
│  └─ bridge/        WebSocket server the desktop app and extension talk over
├─ assets/avatar/    AvatarSample_I.vrm (the single source of truth for the model)
└─ scripts/          sync-assets.mjs (postinstall: copies the VRM into the apps)
```

**Package manager**: pnpm 9 workspaces · **Task runner**: Turborepo · **Language**: TypeScript 5.7, strict,
`noUncheckedIndexedAccess`, ESM (`"type": "module"`, `.js` import specifiers).

---

## 3. Tech stack, and why each choice

| Layer | Choice | Why it was picked |
|---|---|---|
| Extension framework | **WXT** (Manifest V3) | Handles entrypoints, HMR, manifest generation; MV3 without hand-rolling service-worker plumbing |
| UI | **React 18 + Tailwind + rough.js** | Tailwind for speed, `rough.js` for the hand-drawn "pen-sketch" look the project is styled around |
| 3D avatar | **three.js 0.170 + @pixiv/three-vrm 3.4** | VRM is the only sensible open format for a humanoid with expressions/lip-sync |
| Animation | **100% procedural** (`packages/avatar`) | No `.vrma` asset pipeline needed; poses are bone-offset functions, so clips cost no download |
| LLM transport | **Vercel AI SDK** (`streamText`, `generateText`) | Gives `textStream`, tool-calling loop (`maxSteps`), and `onError` in one abstraction |
| Providers | **Groq** (`openai/gpt-oss-120b`) + **NVIDIA NIM** (`openai/gpt-oss-20b`) | Both speak the OpenAI wire format; two of them = free-tier failover |
| STT | **Groq Whisper** (`whisper-large-v3`) via an **offscreen document** | The Web Speech API is unavailable/blocked in Edge; Whisper works everywhere and is already keyed |
| Secrets at rest | **Argon2id (hash-wasm) + AES-256-GCM (WebCrypto)** | Argon2id is the current best-practice KDF; AES-GCM is authenticated so tampering is detectable |
| Local services | **Fastify 5 + zod** | Small, fast, schema validation at the boundary |
| Crawling | **Playwright + jsdom** | Real browser rendering for SPAs, jsdom for cheap HTML parsing |
| Plugin DB | **better-sqlite3** | Zero-setup embedded DB; the backend is single-user and local |
| Desktop | **Tauri v2 (Rust)** | Native transparent always-on-top window at a fraction of Electron's size |
| Tests | **Vitest** | Same transform pipeline as the source; fast |

---

## 4. How it actually works — the flows

### 4.1 Typed chat (side panel)

```
user types → App.tsx sendText()
  ├─ video intent?  parseVideoRequest() → latestVideos() → RichCard (no LLM involved)
  └─ otherwise      runResilient() ── try provider 1 … provider 2 on failure
                       └─ runAgent() (AI SDK) → tool calls → PlatformToolContext methods
                                                 ↓ (each tool returns real data)
                    streaming deltas → updateById() → message list
                    context.takeCards() → the card under the reply
```
Provider failover lives in `apps/extension/src/brain.ts`: a 429/quota marks a provider exhausted for
**5 minutes**, the next provider is tried, and empty replies get **one retry with a nudge** before failing over.

### 4.2 Push-to-talk voice

```
hold Ctrl+Space (browser command, registered in the manifest)
  → content script asks the background to start recording
  → background ensures an OFFSCREEN document exists (ping loop until its listener is live)
  → offscreen: getUserMedia + MediaRecorder → base64
  → release: background posts the clip to Groq Whisper → transcript
  → transcript shown in the bubble ("🗣 …") → same agent run as typed chat → reply + speech
```
Three separate bugs were fixed here: the offscreen listener race, a permanently wedged shortcut after a
rejected message, and the shortcut only working when the *page* had focus (the panel now listens too).

### 4.3 Reading the web

`readPage` is deliberately layered, and each layer falls through on failure:

```
1. owned by the user?  (LinkedIn, Gmail, X, Reddit, Instagram, Facebook, Notion, WhatsApp,
                        Telegram, GitHub)
      → read the user's OWN tab: an existing tab if one is open, else a background tab
        (open → wait for the load event → read via the content script → close)
2. a video?            → POST crawler /transcript  (agent-reach → yt-dlp) → real prose
3. otherwise           → crawler /extract (Playwright)
      → if the text is thin (auth wall / empty SPA), fall back to Jina Reader (r.jina.ai)
```
`searchWeb` prefers the **crawler `/search`** (DuckDuckGo, then a Bing fallback whose redirect links are
unwrapped) so a blocked search engine can't leave the agent blind.

### 4.4 Reminders

```
LLM calls createReminder(title, dueAt)
  → the date is normalised (unparseable → +10 min, already past → +1 min) so it can always fire
  → persisted in chrome.storage, alarm scheduled in the background
  → a card shows the exact time back to the user
firing: notification + in-page bubble line + happy mood + celebrate animation
```
The model only resolves "kal 5 baje" correctly because the system prompt now carries the **current local
time, UTC offset and a "never set a past reminder" rule**.

### 4.5 Plugins (Gmail, Calendar, Notion, GitHub)

```
Plugins tab → "Sign in with Google" → chrome.identity.launchWebAuthFlow (PKCE) → tokens in the extension
                      │
Connect Notion/GitHub → opens the LOCAL API's /oauth/:provider/start in a tab
                        → the API holds the client secrets, does the exchange, and stores the refresh
                          token ENCRYPTED (AES-256-GCM) in SQLite
                        → the panel polls /plugins until the row flips to Connected
```
The extension never sees a provider secret. The Google path uses the browser's own identity API, which is
why the extension ID is pinned with a manifest `key` (the registered redirect URI is
`https://<extension-id>.chromiumapp.org/`).

### 4.6 The avatar

```
AvatarEngine (three.js scene + camera + render loop)
  ├─ ProceduralIdle     breathing, blink, weight shift, micro head motion
  ├─ WalkCycle          Contact/Down/Passing/Up with hip sway and chest counter-rotation
  ├─ ClipPlayer         44 authored clips → 8 shipped (SHIPPED_CLIP_IDS), cross-faded
  ├─ SparkleField       additive-free particle dust on dances/spins (custom per-particle alpha shader)
  ├─ staging.ts         11 named positions + eased entry/exit paths
  └─ framing.ts         per-frame camera re-fit from 7 key bones
```
Every frame the engine adds clip offsets on top of the walk offsets in the **same bone channel**, applies
**relative** root motion (clamped: ±0.18 m x, ±0.12 m z, ±0.16 m y, ±2π turn), then re-fits the camera so no
pose is ever clipped.

---

## 5. Feature status — with evidence

Legend: **✅ verified** (I ran it and saw the result) · **🟡 partial** · **🔴 unverified**

| Area | Status | Evidence / caveat |
|---|---|---|
| Monorepo build | ✅ | 11 projects typecheck; extension build is the long pole (~25–45 s) |
| Avatar renders in Edge | ✅ | DOM probe: host + shadow bubble + canvas, screenshot |
| Idle variety | ✅ | a random shipped clip every ~14 s |
| Push-to-talk → Whisper | ✅ | fake mic: transcript reached **the real Groq API** (its response proved the path) |
| Real microphone | 🔴 | never tested with a human mic |
| Provider failover | ✅ | live: a Groq 429 switched to NVIDIA mid-run |
| Generic form fill (never submits) | ✅ | scan → mapping → confirm card → fill |
| Reminders (create + fire) | 🟡 | creation + normalisation unit-tested; the fired announcement is not visually confirmed |
| Video card (thumbnail, Play) | ✅ | live: real MrBeast thumbnail + watch URL opens |
| Video transcript | ✅ | live: 91,791 chars from yt-dlp for a real video — **but polluted by `::cue` CSS** (see §8) |
| Web search | ✅ | live: crawler returns decoded Bing results |
| Signed-in site reading | 🟡 | implemented and typechecked; a real LinkedIn/Gmail session was not exercised here |
| Vault (Argon2id + AES-GCM) | ✅ | 23 tests + created/unlocked in Edge with zero console errors |
| Gmail / Calendar | 🟡 | code paths exist (zero-setup session + OAuth); no real account verified |
| Notion / GitHub plugins | 🔴 | written and typechecked; never run against the providers (no client IDs configured) |
| Crawler service | ✅ | 61 tests |
| Plugin API | ✅ | 27 tests; /health, 401 on /plugins, live /youtube/latest |
| Desktop shell | 🟡 | Rust builds and launches; the overlay UI is still a placeholder |
| 44 animation clips | 🟡 | all 44 exist and run; only ~5 have been watched and judged |
| Official brand icons | ✅ | brand colours present in the built bundle; panels wired |
| agent-reach tooling | ✅ | `doctor` reports youtube/rss/web/v2ex/bilibili ✅ |

**Rough completion**: core assistant loop ≈ 85% · avatar polish ≈ 40% · plugins ≈ 40% · desktop ≈ 30%.

---

## 6. Tests and verification

```
packages/core     29   providers, orchestrator, memory, tools, errors, prompt-time
packages/vault    23   crypto, store, auto-lock
packages/avatar   17   camera framing math
services/crawler  61   extract, markdown, providers, robots, search, reach parsers
services/api      27   crypto, preview/YouTube parsing, routes
services/bridge    6   WS auth + relay
                ────
                 163
```
End-to-end checks performed by hand during development: extension loaded in **real Edge**, bot rendered,
side-panel tabs exercised, a video card played, the plugin gallery rendered, the vault created/unlocked,
the API and crawler hit over HTTP, transcripts fetched from YouTube.

---

## 7. Local services and ports

| Service | Port | Start | Purpose |
|---|---|---|---|
| Crawler | **17322** | `pnpm --filter @diggy/crawler start` | extract / crawl / search / markdown / transcript / feed / reach |
| Plugin API | **17323** | `pnpm --filter @diggy/api start` | sign-in, OAuth, plugins, actions |
| Bridge | **17321** | `pnpm --filter @diggy/bridge start` | desktop ⇄ extension WebSocket |
| Demo | **5173** | `pnpm --filter @diggy/demo dev` | animation gallery + selection UI |

The extension reaches all of them over loopback; URLs are configurable in ⚙ Settings.

---

## 8. Known weaknesses (stated plainly)

1. **Transcripts contain CSS.** `reach.ts` strips timestamps but not the `STYLE` / `::cue(...)` block, so a
   chunk of the 91k characters is styling. This directly degrades video summaries. *Not fixed.*
2. **Signed-in reads are slow the first time.** A tab that isn't already open needs a real page load
   (2–5 s, LinkedIn heavier). No progress indicator is shown while it happens.
3. **8 of the shipped gestures' look is unapproved** — `waveBoth`, `clap`, `shrug` got the palm/swing
   treatment; the rest of the palette was pruned by the user's own selection, so quality is their call.
4. **Plugins are unproven against real providers.** Google needs the redirect URI registered and (for a
   public release) verification of the sensitive `gmail.readonly` scope.
5. **Crawler adapters for paid vendors** (Firecrawl / Crawl4AI / browser-use) are tested against mocks only.
6. **Desktop overlay UI is a placeholder**; the Rust window and the bridge work.
7. **No CI.** Tests run locally.
8. **The repo has one stray untracked file** (`version.err`) from a tool run.

---

## 9. Security posture

- **API keys are no longer baked into the build.** They are entered in Settings and stored in the browser
  profile; `.env.example` documents what a build may contain. Verified: the real key values are absent from
  the emitted bundle.
- The vault never leaves the browser; Argon2id-derived key, AES-256-GCM, auto-lock on inactivity.
- The plugin API binds **127.0.0.1** only and encrypts refresh tokens at rest.
- Forms are **never auto-submitted**; the tool refuses `submit: true` without an explicit, confirmed path.
- `.env` is gitignored; `.commandcode/` (local tooling) is ignored too.

---

## 10. Next work, in priority order

1. **Strip `STYLE`/`::cue` from transcripts** and de-duplicate auto-subtitle lines — small, direct quality win.
2. **Progress feedback** while a signed-in page is being read ("Reading your LinkedIn tab…").
3. **Verify the gestures** that ship, and re-apply the palm/swing fix anywhere it's still off.
4. **Register the Google redirect URI** and prove the Gmail path end to end.
5. **Desktop overlay UI** — replace the placeholder with the real pocket-bot surface.
6. **CI** — run the 163 tests on every push.

---

## 11. Runbook

```bash
pnpm install                      # also syncs the VRM into the apps (postinstall)
pnpm build                        # turbo build
pnpm test                         # 163 tests

pnpm --filter @diggy/crawler start     # 17322
pnpm --filter @diggy/api start         # 17323
pnpm --filter @diggy/demo dev          # 5173  (animation gallery)

pnpm --filter @diggy/extension build   # → apps/extension/.output/chrome-mv3
```
Load `apps/extension/.output/chrome-mv3` as an unpacked extension, open ⚙ Settings, paste a Groq or NVIDIA
key, then hold **Ctrl+Space** anywhere to talk.

> **Environment note:** this machine runs with `NODE_ENV=production` in some shells, which makes
> `pnpm install` skip devDependencies. If `tsc`/`vitest` go missing, reinstall with
> `pnpm install --prod=false --force`.
