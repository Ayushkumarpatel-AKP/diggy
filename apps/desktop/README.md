# Diggy Desktop

The Diggy desktop companion gives Diggy a native home: a transparent,
always-on-top avatar **overlay** that floats over whatever the user is doing,
plus a supervisor that runs the local bridge the browser extension talks to.

## TL;DR — the bridge works **today**, without Rust

The piece the extension actually needs is a plain Node service and it runs right
now:

```bash
pnpm --filter @diggy/bridge start
# → Diggy bridge is running
#   websocket : ws://127.0.0.1:17321
#   health    : http://127.0.0.1:17321/health
#   token     : <generated, or set DIGGY_BRIDGE_TOKEN to pin one>
```

It binds `127.0.0.1` only, performs the `hello → welcome` handshake with the
shared token, forwards `crawl` / `searchWeb` to the local crawler, logs
`notify` / `speak`, and exposes `GET /health`. Type-check and tests:

```bash
pnpm --filter @diggy/bridge exec tsc --noEmit
pnpm --filter @diggy/bridge test
```

## What lives here

```
apps/desktop/
├── README.md            ← you are here
└── src-tauri/           ← the (not-yet-built) Tauri v2 Rust shell
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── capabilities/default.json
    ├── src/main.rs       app bootstrap + plugins + global shortcut
    ├── src/overlay.rs    transparent always-on-top overlay + click-through
    └── src/commands.rs   start/stop the Node bridge as a child process
```

## The plan

1. **Bridge (done, Node).** `services/bridge` is the single source of truth for
   the local protocol — the Rust shell does not reimplement it, it supervises it.
2. **Overlay (scaffolded, Rust).** A Tauri v2 window that is transparent,
   decoration-less, always-on-top and hidden from the taskbar, with a
   click-through toggle so the user can interact with the page beneath it. A
   `Ctrl+Shift+D` global shortcut shows/hides it.
3. **Supervision (scaffolded, Rust).** `start_bridge` / `stop_bridge` /
   `bridge_status` spawn and track `node services/bridge`, so launching the
   desktop app also brings up the bridge.
4. **Frontend (TODO).** A web UI for the avatar + settings, served from
   `src-tauri`'s `frontendDist`.

## Building the Rust shell

Rust is **not** installed in the current environment, so `src-tauri` is written
but intentionally not built. To build it you need the toolchain:

```bash
rustup default stable          # https://rustup.rs
cd apps/desktop/src-tauri
cargo tauri dev                # or: pnpm dlx @tauri-apps/cli@^2 dev
```

See [`src-tauri/README.md`](src-tauri/README.md) for prerequisites, the file
map and what is stubbed (frontend bundle, icons).
