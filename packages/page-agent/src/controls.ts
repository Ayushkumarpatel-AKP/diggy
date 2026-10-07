/**
 * Submit detection — the input to the **never auto-submit** guarantee.
 *
 * A click or an `Enter` that could submit a form, send a message, delete
 * something or spend money must be classified before it is executed. When it is,
 * the act layer routes it through the policy's `submit` tool (an `irreversible`
 * class → always `confirm`) and then refuses to execute it at all: the user
 * presses it. This module is the single place that decides what "would submit"
 * means, so the rule cannot drift between `click` and `pressKey`.
 */
import {
  descriptiveText,
  isButtonElement,
  isHtmlElement,
  isInputElement,
  isTextareaElement,
} from './dom';

/**
 * Verbs that mark a control as an outward, hard-to-undo action. Kept focused on
 * the dangerous set (submit / send / delete / purchase and close synonyms) —
 * benign verbs like "save" are a reversible write and stay clickable.
 */
export const DESTRUCTIVE_VERB_PATTERN =
  /(submit|send|delete|remove|purchase|buy\b|pay\b|checkout|place\s+order|confirm\s+(order|payment|purchase|booking)|unsubscribe|deactivate|cancel\s+(order|subscription|account)|sign\s?up|register|apply\s+now)/i;

/** Keys whose default action can submit a form. */
const SUBMIT_KEYS = new Set(['enter', 'return', 'numpadenter']);

/**
 * Would clicking this element submit/send/delete/purchase?
 *
 * True when the element is:
 * - an `input[type=submit|image]`;
 * - a `button[type=submit]`;
 * - a `<button>` with no `type` **inside a form** (HTML defaults it to submit);
 * - anything carrying a `formaction`;
 * - or its label/title/value matches {@link DESTRUCTIVE_VERB_PATTERN}.
 */
export function isSubmitControl(el: HTMLElement): boolean {
  if (isInputElement(el) && (el.type === 'submit' || el.type === 'image')) {
    return true;
  }
  if (isButtonElement(el)) {
    const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
    if (type === 'submit') return true;
    if (type === '' && el.closest('form') !== null) return true;
  }
  if (el.hasAttribute('formaction')) return true;
  return DESTRUCTIVE_VERB_PATTERN.test(descriptiveText(el));
}

/** Can pressing this key submit the form around the focused element? */
export function isSubmitKey(key: string, active: Element | null): boolean {
  if (!SUBMIT_KEYS.has(key.trim().toLowerCase())) return false;
  if (!isHtmlElement(active)) return false;
  if (isSubmitControl(active)) return true;
  const isTextField = isInputElement(active) || isTextareaElement(active) || active.isContentEditable;
  return isTextField && active.closest('form') !== null;
}

/** The policy tool name that represents a click on `el`. */
export function clickToolFor(el: HTMLElement): 'submit' | 'fillForm' {
  return isSubmitControl(el) ? 'submit' : 'fillForm';
}

/** The policy tool name that represents a key press. */
export function pressKeyToolFor(key: string, active: Element | null): 'submit' | 'fillForm' {
  return isSubmitKey(key, active) ? 'submit' : 'fillForm';
}
