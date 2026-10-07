/**
 * DOM reading primitives: what counts as interactive, what an element is called,
 * and — importantly — how a secret-bearing value is detected so it is never
 * surfaced.
 *
 * These mirror the conventions of `apps/extension/src/web/dom-scanner.ts`
 * (label sources, `data-diggy-*` stamping, jsdom-safe visibility checks) but are
 * self-contained: this package must not depend on the extension app.
 *
 * ## Realm safety
 * Nothing here uses `el instanceof HTMLInputElement`. A same-origin iframe (and
 * jsdom's iframe documents) have their **own** interface constructors, so
 * `instanceof` is false across the boundary — in a real content script as well
 * as under jsdom. Every element test is therefore structural (`tagName`, duck
 * typing), which is also what makes shadow roots and iframes work.
 */
import { containsVaultValue } from '@diggy/policy';
import type { BoundingBox, ViewportSize } from './types';

/** The string a redacted value is replaced with — never a real secret. */
export const REDACTED_VALUE = '[[REDACTED]]';

/**
 * Attribute a host stamps onto a field it filled from the vault. Any element
 * carrying it has its value redacted in a snapshot, so a `getProfile` value can
 * never round-trip back through the act layer into a model message.
 */
export const VAULT_ATTRIBUTE = 'data-diggy-vault';

const MAX_NAME_LENGTH = 160;

/**
 * Everything the act layer treats as actionable. Deliberately broader than
 * "form fields": the agent also needs buttons, links, tabs and menus. A plain
 * `<div>` matches none of these and is dropped (see {@link isInteractiveElement}).
 */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[onclick]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Input types that hold no user-editable text. */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'file',
  'submit',
  'reset',
  'button',
  'image',
  'range',
  'color',
  'hidden',
]);

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Lowercase tag name. */
export function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

/**
 * Is this an HTML element? Structural (nodeType + tagName), so it is true for
 * elements from another frame's realm — where `instanceof HTMLElement` is not.
 */
export function isHtmlElement(value: unknown): value is HTMLElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Node).nodeType === 1 &&
    typeof (value as HTMLElement).tagName === 'string'
  );
}

export function isInputElement(el: Element): el is HTMLInputElement {
  return tagOf(el) === 'input';
}

export function isTextareaElement(el: Element): el is HTMLTextAreaElement {
  return tagOf(el) === 'textarea';
}

export function isSelectElement(el: Element): el is HTMLSelectElement {
  return tagOf(el) === 'select';
}

export function isButtonElement(el: Element): el is HTMLButtonElement {
  return tagOf(el) === 'button';
}

export function isIframeElement(el: Element): el is HTMLIFrameElement {
  return tagOf(el) === 'iframe';
}

/** The window a node belongs to (`null` for a Document or a detached node). */
export function viewOf(node: Node): Window | null {
  return node.ownerDocument ? node.ownerDocument.defaultView : null;
}

/** The document a scan root belongs to. A Document is its own document. */
export function documentOf(root: ParentNode): Document | null {
  const owner = (root as { ownerDocument?: Document | null }).ownerDocument;
  return owner ?? (root as unknown as Document);
}

/** Is the element (or an ancestor) visually hidden? */
export function isHidden(el: HTMLElement): boolean {
  if (el.hidden) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;

  const win = viewOf(el);
  if (win) {
    try {
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    } catch {
      // getComputedStyle can throw on a detached/exotic element — treat as visible.
    }
  }

  // jsdom does not cascade `display:none` from an ancestor, so walk inline styles.
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (parent.hidden) return true;
    if (parent.style && parent.style.display === 'none') return true;
  }
  return false;
}

/** A disabled control cannot be acted on, so it is not "interactive" here. */
export function isDisabled(el: HTMLElement): boolean {
  if ((el as { disabled?: boolean }).disabled === true) return true;
  return el.getAttribute('aria-disabled') === 'true';
}

/** Does this element match the interactive selector? (structural, not visibility) */
export function matchesInteractive(el: Element): boolean {
  try {
    return el.matches(INTERACTIVE_SELECTOR);
  } catch {
    return false;
  }
}

/**
 * The act layer's definition of interactive: matches
 * {@link INTERACTIVE_SELECTOR}, is not disabled and is not hidden. Everything
 * else — inert text, layout divs, decorative markup — is dropped from a snapshot.
 */
export function isInteractiveElement(el: Element): el is HTMLElement {
  if (!isHtmlElement(el)) return false;
  if (!matchesInteractive(el)) return false;
  if (isDisabled(el)) return false;
  if (isHidden(el)) return false;
  return true;
}

/** Can this element receive typed text? */
export function isTextEntry(el: HTMLElement): boolean {
  if (isInputElement(el)) return !NON_TEXT_INPUT_TYPES.has(el.type);
  if (isTextareaElement(el)) return true;
  return el.isContentEditable;
}

function ariaLabelledByText(el: HTMLElement): string {
  const ids = el.getAttribute('aria-labelledby');
  const doc = el.ownerDocument;
  if (!ids || !doc) return '';
  return ids
    .split(/\s+/)
    .map((id) => clean(doc.getElementById(id)?.textContent))
    .filter(Boolean)
    .join(' ');
}

function labelForText(el: HTMLElement): string {
  const id = el.getAttribute('id');
  const doc = el.ownerDocument;
  if (!id || !doc) return '';
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
  let nodes: NodeListOf<Element>;
  try {
    nodes = doc.querySelectorAll(`label[for="${escaped}"]`);
  } catch {
    return '';
  }
  return Array.from(nodes)
    .map((node) => clean(node.textContent))
    .filter(Boolean)
    .join(' ');
}

function wrappingLabelText(el: HTMLElement): string {
  const label = el.closest('label');
  if (!label) return '';
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input, textarea, select, button').forEach((node) => node.remove());
  return clean(clone.textContent);
}

function nativeName(el: HTMLElement): string {
  if (isInputElement(el)) {
    if (el.type === 'image') return clean(el.getAttribute('alt'));
    if (el.type === 'submit' || el.type === 'reset' || el.type === 'button') return clean(el.value);
  }
  return '';
}

/**
 * Best-effort accessible name, from the highest-signal source down:
 * `aria-labelledby` → `aria-label` → `<label for>` → wrapping `<label>` →
 * native (submit value / image alt) → text content → `placeholder` → `title` →
 * `name`.
 */
export function accessibleName(el: HTMLElement): string {
  const candidates = [
    ariaLabelledByText(el),
    el.getAttribute('aria-label'),
    labelForText(el),
    wrappingLabelText(el),
    nativeName(el),
    clean(el.textContent),
    el.getAttribute('placeholder'),
    el.getAttribute('title'),
    el.getAttribute('name'),
  ];
  for (const candidate of candidates) {
    const text = clean(candidate);
    if (text) return clamp(text, MAX_NAME_LENGTH);
  }
  return '';
}

/**
 * The label an action summary *and* the submit-verb check use. Prefers the
 * accessible name, then a control's own value/text/title.
 */
export function descriptiveText(el: HTMLElement): string {
  const named = accessibleName(el);
  if (named) return named;
  if (isInputElement(el)) return clean(el.value) || clean(el.getAttribute('value'));
  return clean(el.textContent) || clean(el.getAttribute('aria-label')) || clean(el.getAttribute('title'));
}

/** The ARIA role: an explicit `role=` wins, else it is inferred from the tag/type. */
export function deriveRole(el: HTMLElement): string {
  const explicit = clean(el.getAttribute('role')).toLowerCase();
  if (explicit) return explicit;

  const tag = tagOf(el);
  if (tag === 'a' || tag === 'area') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (isSelectElement(el)) return el.multiple ? 'listbox' : 'combobox';
  if (isTextareaElement(el)) return 'textbox';
  if (el.isContentEditable) return 'textbox';
  if (isInputElement(el)) {
    switch (el.type) {
      case 'submit':
      case 'image':
      case 'button':
      case 'reset':
        return 'button';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'range':
        return 'slider';
      case 'number':
        return 'spinbutton';
      case 'search':
        return 'searchbox';
      default:
        return 'textbox';
    }
  }
  return 'generic';
}

/** The control's `type` string, when it has a meaningful one. */
export function controlType(el: HTMLElement): string | undefined {
  if (isInputElement(el)) return el.type;
  if (isButtonElement(el)) {
    const explicit = clean(el.getAttribute('type')).toLowerCase();
    if (explicit) return explicit;
    return el.closest('form') ? 'submit' : 'button';
  }
  if (isSelectElement(el)) return el.multiple ? 'select-multiple' : 'select';
  if (isTextareaElement(el)) return 'textarea';
  if (el.isContentEditable) return 'contenteditable';
  return undefined;
}

function rawValue(el: HTMLElement): string | undefined {
  if (isInputElement(el)) return el.value;
  if (isTextareaElement(el)) return el.value;
  if (isSelectElement(el)) return el.value;
  if (el.isContentEditable) return clean(el.textContent);
  return undefined;
}

function isValueBearing(el: HTMLElement): boolean {
  return (
    isInputElement(el) || isTextareaElement(el) || isSelectElement(el) || el.isContentEditable
  );
}

/**
 * The value to expose for an element, redacting anything secret.
 *
 * Redacted when **any** of these hold:
 * - it is an `input[type=password]`;
 * - it (or the host) marked the element with {@link VAULT_ATTRIBUTE};
 * - its value contains a value registered with `@diggy/policy`'s
 *   `registerVaultValue`.
 */
export function valueFor(el: HTMLElement): { value?: string; redacted: boolean } {
  if (!isValueBearing(el)) return { redacted: false };
  if (isInputElement(el) && el.type === 'password') {
    return { value: REDACTED_VALUE, redacted: true };
  }
  if (el.hasAttribute(VAULT_ATTRIBUTE)) return { value: REDACTED_VALUE, redacted: true };

  const raw = rawValue(el);
  if (raw !== undefined && raw !== '' && containsVaultValue(raw)) {
    return { value: REDACTED_VALUE, redacted: true };
  }
  return raw === undefined ? { redacted: false } : { value: raw, redacted: false };
}

/** The element's viewport-relative box (all zeros under jsdom — no layout). */
export function bboxOf(el: HTMLElement): BoundingBox {
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Does the element intersect the viewport?
 *
 * An element with a non-zero box intersects when it overlaps `[0, width] ×
 * [0, height]`. jsdom has no layout and reports a zero-size box for everything,
 * so under jsdom this is `false` unless a test stubs `getBoundingClientRect`.
 */
export function isInViewport(el: HTMLElement, viewport?: ViewportSize): boolean {
  const rect = el.getBoundingClientRect();
  const win = viewOf(el);
  const width = viewport?.width ?? win?.innerWidth ?? 0;
  const height = viewport?.height ?? win?.innerHeight ?? 0;
  if (width <= 0 && height <= 0) return true; // no viewport metric — cannot judge
  if (rect.width <= 0 && rect.height <= 0) return false;
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}

/** An event constructor from the element's own realm (iframes have their own). */
function eventCtorFor<T>(el: HTMLElement, name: 'Event' | 'KeyboardEvent'): T | undefined {
  const view = el.ownerDocument?.defaultView as (Window & Record<string, unknown>) | null;
  const fromView = view ? (view[name] as T | undefined) : undefined;
  if (fromView) return fromView;
  const globalCtor = (globalThis as Record<string, unknown>)[name] as T | undefined;
  return globalCtor;
}

/** Dispatch a bubbling synthetic event on an element. */
export function dispatch(el: HTMLElement, type: string): void {
  const Ctor = eventCtorFor<typeof Event>(el, 'Event');
  if (!Ctor) return;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
}

/** Dispatch a bubbling synthetic `KeyboardEvent`. */
export function dispatchKey(el: HTMLElement, type: string, key: string): void {
  const Ctor = eventCtorFor<typeof KeyboardEvent>(el, 'KeyboardEvent');
  if (Ctor) {
    el.dispatchEvent(new Ctor(type, { key, bubbles: true, cancelable: true }));
    return;
  }
  dispatch(el, type);
}

/**
 * Set a field's value the way a real user would, so framework value trackers
 * see it: through the native setter (from the element's own realm) plus `input`
 * and `change` events.
 */
export function setFieldValue(el: HTMLElement, text: string): void {
  if (isInputElement(el) || isTextareaElement(el)) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) {
      try {
        setter.call(el, text);
      } catch {
        el.value = text;
      }
    } else {
      el.value = text;
    }
    dispatch(el, 'input');
    dispatch(el, 'change');
    return;
  }
  if (el.isContentEditable) {
    el.textContent = text;
    dispatch(el, 'input');
  }
}
