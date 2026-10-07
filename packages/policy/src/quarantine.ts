/**
 * Quarantined reader contract.
 *
 * A signed-in page read is the highest-risk data the agent ever touches: the raw
 * text is live, private and adversarial. The contract is that the *tool-using*
 * agent never sees it. Instead the raw text is fenced as untrusted DATA and given
 * to {@link runNoTools} — a reader the caller guarantees cannot call tools — and
 * only that reader's summary is handed back.
 *
 * Read {@link QUARANTINE_CALLER_OBLIGATION} before wiring this up.
 */
import { wrapUntrusted } from './untrusted';

/** What {@link summarizeUntrusted} hands back. */
export interface QuarantineOutcome<T> {
  /** The no-tools reader's output — the only thing the tool-using agent sees. */
  summary: T;
  /** The exact DATA-fenced block that was given to the reader. */
  fenced: string;
  /** The label used on the fence. */
  label: string;
}

/**
 * The obligations on whoever calls {@link summarizeUntrusted}. Kept as an
 * exported string so it can be surfaced in docs or an assertion.
 */
export const QUARANTINE_CALLER_OBLIGATION = [
  'summarizeUntrusted() quarantines untrusted text (a signed-in page read, an email body, a transcript or a plugin result) behind a DATA fence and hands it to a no-tools reader.',
  'CALLER OBLIGATIONS:',
  '1. runNoTools MUST run with NO tools — only read and summarise the fenced text. Pass a plain LLM call with an empty toolset (or a pure function), never the tool-calling agent.',
  '2. The tool-using agent must ONLY ever receive the returned `summary`. For signed-in pages it must never see the raw text or the fenced block.',
  '3. If that summary is later fed into the tool-using turn, treat that turn as tainted (call markUntrusted) so every outward-effect tool still requires confirmation.',
].join('\n');

/**
 * Fence `text` as untrusted DATA and have `runNoTools` summarise it.
 *
 * Never throws synchronously on garbage `text` (it is coerced and fenced); it
 * only rejects if `runNoTools` is not a function, or if `runNoTools` itself
 * throws/rejects — which is left to propagate so the caller sees the failure.
 *
 * @param text raw untrusted content.
 * @param runNoTools a function guaranteed to run with no tools.
 * @param options optional `label` for the fence (e.g. `'linkedin.com/notifications'`).
 */
export function summarizeUntrusted<T>(
  text: unknown,
  runNoTools: (fenced: string) => T | Promise<T>,
  options?: { label?: string },
): Promise<QuarantineOutcome<T>> {
  if (typeof runNoTools !== 'function') {
    return Promise.reject(
      new TypeError('summarizeUntrusted: runNoTools must be a function that runs with no tools'),
    );
  }
  const label =
    typeof options?.label === 'string' && options.label.trim() !== ''
      ? options.label.trim()
      : 'untrusted content';
  const fenced = wrapUntrusted(label, text);
  return Promise.resolve()
    .then(() => runNoTools(fenced))
    .then((summary) => ({ summary, fenced, label }));
}
