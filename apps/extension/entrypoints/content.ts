/**
 * Diggy content script — the extension's "eyes and hands" on every page.
 *
 *  - mounts a floating "pocket bot" avatar in an isolated shadow root (bottom corner)
 *  - answers `scanFields` / `readPage` / `fillForm` / avatar / speak requests
 *  - runs a *throttled, silent-by-default* DOM observer (no spam)
 *
 * It never submits a form.
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AVATAR_MODEL_PATH, type PageContext } from '@diggy/shared';
import { AvatarBubble, BUBBLE_STYLES, bubbleBus } from '../src/content/avatar-bubble';
import { isContentExec } from '../src/messages';
import type {
  ContentExecMessage,
  ContentMethod,
  ContentMethodParams,
  ContentMethodResults,
  ContentResponse,
} from '../src/messages';
import { scanFields } from '../src/web/dom-scanner';
import { fillFields } from '../src/web/form-filler';
import { createDomObserver } from '../src/web/observer';

const HOST_ID = 'diggy-avatar-host';

let avatarVisible = true;

function mountBubble(): Root | null {
  if (document.getElementById(HOST_ID)) return null;

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
      initialVisible: avatarVisible,
      side: 'left',
    }),
  );
  return root;
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

    const root = mountBubble();

    // Throttled, silent-by-default observer: it only marks the DOM dirty and
    // reports when someone explicitly asks (`setReporting(true)` / `requestReport`).
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

    ctx.onInvalidated(() => {
      observer.stop();
      root?.unmount();
      document.getElementById(HOST_ID)?.remove();
      scope.__diggyContentMounted = false;
    });
  },
});
