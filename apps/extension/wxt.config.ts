import { defineConfig } from 'wxt';

/**
 * Diggy browser extension (Manifest V3, Chrome/Edge).
 *
 * The extension is the "eyes and hands" of Diggy: it reads pages, fills forms
 * from the encrypted profile, relays notifications/reminders, and hosts the
 * in-page avatar bubble. The heavy brain logic lives in @diggy/core and is
 * driven from the side panel (with a localhost WS bridge to the desktop
 * companion when it is running — see entrypoints/background.ts).
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  manifest: {
    name: 'Diggy — Animated Companion',
    short_name: 'Diggy',
    description:
      'Diggy reads the page, fills forms from your profile, tracks reminders, researches the web and shows a lively animated avatar. Never submits a form on its own.',
    permissions: [
      'storage',
      'scripting',
      'tabs',
      'activeTab',
      'alarms',
      'notifications',
      'sidePanel',
      'contextMenus',
      'webNavigation',
      'offscreen',
      'identity',
    ],
    host_permissions: ['<all_urls>'],
    // Browser-level push-to-talk. A page never sees a chord that another
    // extension has claimed globally, so this guarantees the shortcut works.
    // Commands have no key-up → it toggles (press to start, press again to send).
    commands: {
      'toggle-voice': {
        suggested_key: { default: 'Ctrl+Shift+Space' },
        description: 'Talk to Diggy (press to start, press again to send)',
      },
    },
    // The vault derives its key with Argon2id via WebAssembly (hash-wasm), which
    // MV3's default `script-src 'self'` blocks. `'wasm-unsafe-eval'` allows
    // WebAssembly compilation without permitting general eval.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    // The in-page avatar (content script) fetches the VRM model, so it must be
    // declared web-accessible — otherwise the fetch is blocked and the bot
    // falls back to the placeholder face.
    web_accessible_resources: [
      {
        resources: ['AvatarSample_I.vrm', 'assets/*', 'chunks/*.js'],
        matches: ['<all_urls>'],
      },
    ],
    // The side_panel.default_path is wired up automatically from the
    // `entrypoints/sidepanel/index.html` entrypoint. `action` gives us a
    // toolbar button that opens the side panel.
    action: {
      default_title: 'Open Diggy',
    },
  },
});
