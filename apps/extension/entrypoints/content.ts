/**
 * Diggy content script — the extension's "eyes and hands" on every page.
 *
 *  - mounts a floating "pocket bot" avatar in an isolated shadow root (bottom corner)
 *  - answers `scanFields` / `readPage` / `fillForm` / avatar / speak requests
 *  - runs a *throttled, silent-by-default* DOM observer (no spam)
 *
 * It never submits a form.
 *
 * Phase 6 — battery. A VRM loop in *every* tab is the most expensive thing this
 * product does, so this script is now frugal about when the avatar even exists:
 *  - the 17 MB model is **not fetched** until the avatar is first shown (lazy
 *    load: the bubble is created hidden, and `VrmAvatar` — the only thing that
 *    fetches the model — is not mounted until it is revealed),
 *  - the tab renders at 30 fps by default and parks entirely while hidden,
 *    releasing its GPU memory after 60 s (see `AvatarEngine`),
 *  - it never mounts the avatar at all on the per-site disable list.
 *
 * Lazy load is gated by `Settings.avatarAutoLoad` (default `false`); the
 * existing `Settings.avatarVisible` still decides whether the bubble is shown.
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AVATAR_MODEL_PATH, type PageContext } from '@diggy/shared';
import { AvatarBubble, BUBBLE_STYLES, bubbleBus } from '../src/content/avatar-bubble';
import {
  isAgentDelta,
  isAgentDone,
  isAgentHeard,
  isContentExec,
  isFillPlan,
} from '../src/messages';
import type {
  ContentExecMessage,
  ContentMethod,
  ContentMethodParams,
  ContentMethodResults,
  ContentResponse,
} from '../src/messages';
import { getSettings, isAvatarDisabledForHost, type Settings } from '../src/storage';
import { scanFields } from '../src/web/dom-scanner';
import { fillFields } from '../src/web/form-filler';
import { createDomObserver } from '../src/web/observer';

const HOST_ID = 'diggy-avatar-host';

/**
 * The tab's single avatar slot.
 *
 * ONE WEBGL CONTEXT PER TAB. Browsers cap the number of live WebGL contexts per
 * renderer process (Chrome: ~16) and, once the cap is hit, silently kill the
 * *oldest* context — which surfaces as a black/frozen avatar and a
 * `webglcontextlost` nobody is listening for. So the content script owns
 * exactly one slot: `mountBubble` refuses to create a second host, which also
 * catches a re-injected copy of this file racing the first run, and
 * `onInvalidated` empties the slot so a later injection can take over cleanly.
 */
const avatarSlot: { root: Root | null } = { root: null };

/** Mirrors the `avatarVisible` setting; kept in sync by the side panel. */
let avatarVisible = true;

/**
 * DEV ONLY: let `AvatarEngine` publish its `window.__diggyPerf` readout.
 *
 * The read is the literal `import.meta.env.DEV` so Vite/WXT can replace it at
 * build time — an intermediate variable would defeat the replacement and the
 * helper would never turn on.
 */
function enablePerfReporting(): void {
  const scope = window as unknown as { __diggyPerfEnabled?: boolean };
  if (scope.__diggyPerfEnabled !== undefined) return;
  try {
    if (import.meta.env.DEV === true) scope.__diggyPerfEnabled = true;
  } catch {
    /* no bundler env — the engine's own dev detection still applies */
  }
}

function mountBubble(initialVisible: boolean): Root | null {
  // One host — and therefore one canvas and one WebGL context — per document.
  if (avatarSlot.root || document.getElementById(HOST_ID)) return null;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = BUBBLE_STYLES;
  shadow.appendChild(style);

  const container = document.createElement('div');
  shadow.appendChild(container);
  (document.body ?? document.documentElement).appendChild(host);

  const root = createRoot(container);
  root.render(
    createElement(AvatarBubble, {
      modelUrl: browser.runtime.getURL(AVATAR_MODEL_PATH),
      // Lazy by default: while this is false the bubble renders only its
      // controls, `VrmAvatar` never mounts and the model is never fetched.
      // The bubble's own toggle (or `installLazyReveal` below) flips it true.
      initialVisible,
      side: 'left',
    }),
  );
  avatarSlot.root = root;
  return root;
}

/**
 * Reveal a lazily-loaded avatar exactly once, then disarm.
 *
 * Two triggers, matching "hidden until the user's first interaction or the
 * first assistant reply": the first assistant reply arriving from the
 * background, and the user's first gesture on the page. Bubble controls are
 * deliberately excluded from the gesture listener — the toggle button flips
 * visibility itself and the mic reveals on the reply, so reacting to those too
 * would toggle the avatar straight back off.
 *
 * Returns a disposer for `onInvalidated`.
 */
function installLazyReveal(): () => void {
  let cancelled = false;

  function cleanup(): void {
    if (cancelled) return;
    cancelled = true;
    try {
      browser.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* ignore */
    }
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
  }

  const reveal = (): void => {
    cleanup();
    bubbleBus.emit({ type: 'visible', visible: true });
  };

  function onMessage(raw: unknown): undefined {
    if (isAgentDone(raw) || isAgentDelta(raw) || isAgentHeard(raw) || isFillPlan(raw)) reveal();
    return undefined;
  }

  function isBubbleControl(event: Event): boolean {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      const className = (node as { className?: unknown }).className;
      if (typeof className === 'string' && /diggy-bubble__(toggle|mic)/.test(className)) return true;
    }
    return false;
  }

  function onGesture(event: Event): void {
    if (isBubbleControl(event)) return;
    reveal();
  }

  browser.runtime.onMessage.addListener(onMessage);
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  return cleanup;
}

/* ------------------------------------------------------------------ *
 * Page reading / filling
 * ------------------------------------------------------------------ */

function readPageContext(includeFields: boolean): PageContext {
  const body = document.body;
  const raw = (body?.innerText ?? body?.textContent ?? '') as string;
  const text = raw
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 20_000);

  return {
    url: location.href,
    title: document.title,
    text,
    fields: includeFields ? scanFields() : undefined,
  };
}

function speak(text: string): boolean {
  if (typeof speechSynthesis === 'undefined') return false;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-US';
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

function toggleAvatar(visible?: boolean): boolean {
  avatarVisible = visible ?? !avatarVisible;
  bubbleBus.emit({ type: 'visible', visible: avatarVisible });
  return avatarVisible;
}

/* ------------------------------------------------------------------ *
 * Response helpers
 * ------------------------------------------------------------------ */

function ok<M extends ContentMethod>(method: M, result: ContentMethodResults[M]): ContentResponse<M> {
  return { type: 'diggy:content-response', ok: true, method, result };
}

function fail<M extends ContentMethod>(method: M, error: string): ContentResponse<M> {
  return { type: 'diggy:content-response', ok: false, method, error };
}

async function handleExec(message: ContentExecMessage): Promise<ContentResponse> {
  const { method } = message;
  try {
    switch (method) {
      case 'ping':
        return ok('ping', true);
      case 'scanFields':
        return ok('scanFields', scanFields());
      case 'readPage':
        return ok(
          'readPage',
          readPageContext((message.params as ContentMethodParams['readPage']).includeFields ?? true),
        );
      case 'fillForm':
        return ok('fillForm', fillFields((message.params as ContentMethodParams['fillForm']).fields));
      case 'speak':
        return ok('speak', speak((message.params as ContentMethodParams['speak']).text));
      case 'setMood':
        bubbleBus.emit({ type: 'mood', mood: (message.params as ContentMethodParams['setMood']).mood });
        return ok('setMood', true);
      case 'playAnim':
        bubbleBus.emit({ type: 'anim', state: (message.params as ContentMethodParams['playAnim']).state });
        return ok('playAnim', true);
      case 'toggleAvatar':
        return ok('toggleAvatar', toggleAvatar((message.params as ContentMethodParams['toggleAvatar']).visible));
      default:
        return fail(method, `Unknown content method: ${String(method)}`);
    }
  } catch (error) {
    return fail(method, error instanceof Error ? error.message : 'content-error');
  }
}

/* ------------------------------------------------------------------ *
 * Entrypoint
 * ------------------------------------------------------------------ */

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    // Guard: the background re-injects this file into tabs that were already
    // open when the extension (re)loaded, so `main` can run twice in the same
    // isolated world. Only the first run mounts and registers listeners —
    // `onInvalidated` clears the flag so the re-injection can take over.
    const scope = window as unknown as { __diggyContentMounted?: boolean };
    if (scope.__diggyContentMounted) return;
    scope.__diggyContentMounted = true;

    enablePerfReporting();

    let invalidated = false;
    let stopLazyReveal: (() => void) | null = null;

    // Throttled, silent-by-default observer: it only marks the DOM dirty and
    // reports when someone explicitly asks (`setReporting(true)` / `requestReport`).
    // Page reading/filling stays available even where the avatar is disabled.
    const observer = createDomObserver({
      throttleMs: 1500,
      onReport(report) {
        void browser.runtime
          .sendMessage({ type: 'diggy:content-event', event: 'dom-changed', payload: report })
          .catch(() => undefined);
      },
    });
    observer.start();

    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!isContentExec(message)) return undefined;
      return handleExec(message);
    });

    // Announce readiness (best-effort).
    void browser.runtime
      .sendMessage({ type: 'diggy:content-event', event: 'ready', payload: { url: location.href } })
      .catch(() => undefined);

    // Mounting waits on settings: the per-site disable list and the lazy-load
    // flags both live there. Everything above is already running by this point.
    void (async () => {
      let settings: Settings | null = null;
      try {
        settings = await getSettings();
      } catch {
        settings = null; // defaults are safe: avatar on, lazy load, no extra denies
      }
      if (invalidated) return;

      // Never draw a bot on a sensitive site (banks, payments, password
      // managers, health portals…). `isAvatarDisabledForHost` fails closed.
      if (isAvatarDisabledForHost(location.hostname, settings)) return;

      avatarVisible = settings?.avatarVisible !== false;
      const autoLoad = settings?.avatarAutoLoad === true;

      // `avatarVisible` still wins: if the user turned the bubble off we create
      // it hidden and never auto-reveal. Otherwise `autoLoad` decides whether the
      // model is fetched now (`true`) or on first show (`false`, the default).
      mountBubble(avatarVisible && autoLoad);
      if (avatarVisible && !autoLoad) stopLazyReveal = installLazyReveal();
    })();

    ctx.onInvalidated(() => {
      invalidated = true;
      stopLazyReveal?.();
      stopLazyReveal = null;
      observer.stop();
      avatarSlot.root?.unmount();
      avatarSlot.root = null;
      document.getElementById(HOST_ID)?.remove();
      scope.__diggyContentMounted = false;
    });
  },
});
