/**
 * Microphone permission recovery page (`permissions.html`, Phase 5).
 *
 * Why this page exists
 * --------------------
 * `getUserMedia` inside the offscreen recorder document fails with
 * `NotAllowedError` when the origin has no microphone permission yet, and an
 * offscreen document has no UI, so it can never show the prompt itself. A
 * content script would need the *page's* permission instead of the extension's.
 *
 * A normal extension page with a real click on it satisfies Chrome's
 * "user gesture" requirement, so this page has exactly one job: call
 * `getUserMedia({ audio: true })` for the whole extension origin, then tell the
 * background worker to retry the recording it could not start.
 *
 * Nothing is recorded here — the stream is stopped the moment it arrives, so no
 * audio ever leaves this page.
 */
import { VOICE_COPY, signalMicPermission } from '../../src/messages';

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

const title = byId('title');
const body = byId('body');
const status = byId('status');
const once = byId('once');
const notice = byId('notice');
const allow = byId('allow') as HTMLButtonElement;

function setStatus(text: string, tone: 'ok' | 'bad' | 'none' = 'none'): void {
  status.textContent = text;
  if (tone === 'none') status.removeAttribute('data-tone');
  else status.setAttribute('data-tone', tone);
}

let busy = false;

/**
 * Ask for the microphone. The click is the user gesture Chrome wants; the
 * stream is closed again immediately so this page never holds the mic.
 */
async function allowMicrophone(): Promise<void> {
  if (busy) return;
  busy = true;
  allow.disabled = true;
  setStatus(VOICE_COPY.permissionAsking);

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(VOICE_COPY.permissionNoSupport, 'bad');
    await signalMicPermission(false, 'mediaDevices-unavailable');
    busy = false;
    allow.disabled = false;
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop every track right away: this page only needs the *permission*.
    stream.getTracks().forEach((track) => track.stop());

    setStatus(VOICE_COPY.permissionRetrying, 'ok');
    // The background retries the recording once and answers with the outcome.
    const result = await signalMicPermission(true);
    if (result.ok === false) {
      setStatus(result.error || VOICE_COPY.permissionDenied, 'bad');
    } else {
      setStatus(VOICE_COPY.permissionGranted, 'ok');
      // `window.close()` works because the background opens this as a popup
      // window; if the user opened the tab by hand it is a harmless no-op.
      window.setTimeout(() => {
        try {
          window.close();
        } catch {
          /* leaving the tab open is fine */
        }
      }, 1200);
    }
    allow.disabled = false;
    busy = false;
  } catch (error) {
    // Denied, or the device could not be opened. Say what to do next.
    setStatus(VOICE_COPY.permissionDenied, 'bad');
    await signalMicPermission(false, error instanceof Error ? error.message : String(error));
    allow.disabled = false;
    busy = false;
  }
}

allow.addEventListener('click', () => void allowMicrophone());

document.title = VOICE_COPY.permissionTitle;
title.textContent = VOICE_COPY.permissionTitle;
body.textContent = VOICE_COPY.permissionBody;
allow.textContent = VOICE_COPY.permissionButton;
once.textContent = VOICE_COPY.permissionOnce;
// The Settings first-run notice, word for word — this is the surface where the
// user actually turns voice on, so it is shown here as well.
notice.textContent = VOICE_COPY.firstRunNotice;
