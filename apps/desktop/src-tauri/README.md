# Diggy Desktop — Tauri shell (`src-tauri`)

This is the **Rust** half of the Diggy desktop companion. It is a Tauri v2 app
whose job is small and specific:

- own a **transparent, always-on-top, decoration-less "overlay" window** for the
  Diggy avatar (plus a normal `main` window for settings/chat);
- expose a command to flip the overlay into **click-through** mode
  (`set_ignore_cursor_events`) so the user can keep clicking the page beneath it;
- **supervise the Node bridge** — start/stop `@diggy/bridge` as a child process.

> ⚠️ **Rust is required to build this crate and it is not installed in this
> environment.** Nothing here is compiled as part of the normal JS workflow.
> The working bridge the extension actually talks to today is the pure-Node one
> under [`services/bridge`](../../../services/bridge) — see
> [`../README.md`](../README.md).

## Prerequisites

Install the Rust toolchain and the Tauri system dependencies:

```bash
# 1. Rust (this is the step that is currently missing)
#    https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable

# 2. Platform libraries for Tauri v2 (WebKitGTK on Linux, etc.)
#    https://tauri.app/start/prerequisites/
```

You also need the frontend it loads (`tauri.conf.json` → `build.frontendDist`,
currently `../dist`) to exist. Until a desktop frontend is added, point
`frontendDist` at any static bundle that contains an `index.html`.

## Layout

| File | Purpose |
| --- | --- |
| `Cargo.toml` | Tauri v2 + `tauri-plugin-notification` + `tauri-plugin-global-shortcut`. |
| `tauri.conf.json` | Declares the `main` and transparent `overlay` windows, app identifier and bundle config. |
| `build.rs` | `tauri_build::build()` — generates the context `generate_context!()` needs. |
| `src/main.rs` | Builds the app, registers plugins, creates the overlay, registers `Ctrl+Shift+D`. |
| `src/overlay.rs` | Creates the transparent always-on-top overlay and the click-through command. |
| `src/commands.rs` | `start_bridge` / `stop_bridge` / `bridge_status` — spawns `node services/bridge`. |
| `capabilities/default.json` | Tauri v2 permission set for the windows/plugins above. |

## Run it

```bash
# from this directory (apps/desktop/src-tauri)
cargo tauri dev      # or: pnpm dlx @tauri-apps/cli@^2 dev
cargo tauri build    # production bundle
```

Front-end commands (all optional and read from `tauri.conf.json`'s `build`
block): `beforeDevCommand`, `devUrl`, `frontendDist`.

## What is stubbed

- The frontend (`../dist`) is **not** included yet — the windows currently load
  `index.html`, which a future desktop UI will provide.
- Bundle **icons** (`bundle.icon`) are referenced but not committed; generate
  them with `cargo tauri icon path/to/logo.png`.
- The bridge child process assumes `node` and `tsx` are on `PATH` (they are, in
  the pnpm workspace), and that `tsx` can be resolved from the workspace root.

`cargo tauri` is invoked via `cargo` because this environment has no `tauri`
CLI installed.
