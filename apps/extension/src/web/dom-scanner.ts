/**
 * DOM field scanner — "the eyes".
 *
 * Collects the fillable fields on a page (`input`, `textarea`, `select` and
 * `[contenteditable]` elements) and describes each one the way an LLM (and the
 * form filler) needs it: a stable handle, label text from every common source,
 * name/placeholder/aria-label, type, required flag and (for selects/radios) the
 * available options.
 *
 * Nothing here fills anything or talks to the network — it only reads.
 */
import type { FieldDescriptor } from '@diggy/shared';

const FIELD_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(',');

/** Input types that are never "fillable" data fields. */
const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

const MAX_LABEL_LENGTH = 160;
const MAX_NEARBY_LENGTH = 120;

let idCounter = 0;

function nextFieldId(): string {
  idCounter += 1;
  return `diggy-field-${idCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Return a stable id for an element, stamping it onto the DOM as
 * `data-diggy-field-id` so the filler can find it again later.
 */
export function ensureFieldId(el: HTMLElement): string {
  const existing = el.getAttribute('data-diggy-field-id');
  if (existing) return existing;
  const id = nextFieldId();
  el.setAttribute('data-diggy-field-id', id);
  return id;
}

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function textOf(el: Element | null): string {
  return clean(el?.textContent);
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isEditable(el: HTMLElement): boolean {
  return el.isContentEditable;
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

function isDisabledOrReadonly(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.disabled || el.readOnly;
  }
  if (el instanceof HTMLSelectElement) {
    return el.disabled;
  }
  return el.getAttribute('aria-disabled') === 'true';
}

function ariaLabelledByText(el: HTMLElement): string {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  return ids
    .split(/\s+/)
    .map((id) => textOf(document.getElementById(id)))
    .filter(Boolean)
    .join(' ');
}

function labelForText(el: HTMLElement): string {
  const id = el.getAttribute('id');
  if (!id || typeof CSS === 'undefined' || typeof CSS.escape !== 'function') return '';
  const nodes = document.querySelectorAll(`label[for="${CSS.escape(id)}"]`);
  return Array.from(nodes)
    .map((node) => textOf(node))
    .filter(Boolean)
    .join(' ');
}

function wrappingLabelText(el: HTMLElement): string {
  const label = el.closest('label');
  if (!label) return '';
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input, textarea, select, button').forEach((node) => node.remove());
  return textOf(clone);
}

function nearbyText(el: HTMLElement): string {
  const previous = el.previousElementSibling;
  const previousText = textOf(previous);
  if (previousText && previousText.length <= MAX_NEARBY_LENGTH) return previousText;

  const parent = el.parentElement;
  if (parent) {
    const clone = parent.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, textarea, select, button, [contenteditable]').forEach((node) => node.remove());
    const text = textOf(clone);
    if (text && text.length <= MAX_NEARBY_LENGTH) return text;
  }
  return '';
}

/** Best-effort human label for a field, from the highest-signal source down. */
export function deriveLabel(el: HTMLElement): string {
  const candidates = [
    el.getAttribute('aria-label'),
    ariaLabelledByText(el),
    labelForText(el),
    wrappingLabelText(el),
    el.getAttribute('title'),
    el.getAttribute('placeholder'),
    nearbyText(el),
    el.getAttribute('name'),
  ];
  for (const candidate of candidates) {
    const text = clean(candidate);
    if (text) return clamp(text, MAX_LABEL_LENGTH);
  }
  return '';
}

function isRequired(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.required) return true;
  }
  return el.getAttribute('aria-required') === 'true';
}

function selectOptions(select: HTMLSelectElement): string[] {
  return Array.from(select.options)
    .map((option) => clean(option.textContent) || option.value)
    .filter((option) => option.length > 0);
}

/** Describe a single element as a {@link FieldDescriptor}. */
export function describeField(el: HTMLElement): FieldDescriptor {
  const id = ensureFieldId(el);
  const name = el.getAttribute('name') ?? undefined;
  const ariaLabel = el.getAttribute('aria-label') ?? undefined;
  const label = deriveLabel(el) || undefined;
  const required = isRequired(el) || undefined;

  if (el instanceof HTMLSelectElement) {
    return {
      id,
      tag: 'select',
      type: el.multiple ? 'multiple' : 'select',
      name,
      label,
      ariaLabel,
      required,
      options: selectOptions(el),
    };
  }

  if (el instanceof HTMLTextAreaElement) {
    return {
      id,
      tag: 'textarea',
      type: 'textarea',
      name,
      label,
      placeholder: el.placeholder || undefined,
      ariaLabel,
      required,
    };
  }

  if (el instanceof HTMLInputElement) {
    return {
      id,
      tag: 'input',
      type: el.type,
      name,
      label,
      placeholder: el.placeholder || undefined,
      ariaLabel,
      required,
    };
  }

  // `[contenteditable]` (usually a <div>) — surface it as a free-text field.
  return {
    id,
    tag: 'textarea',
    type: 'contenteditable',
    name,
    label,
    ariaLabel,
    required,
  };
}

export interface FieldEntry {
  el: HTMLElement;
  descriptor: FieldDescriptor;
}

/**
 * Collect the fields under `root` (defaults to `document`), keeping their DOM
 * elements alongside the descriptors. Radio inputs sharing a `name` collapse
 * into a single descriptor with the whole group as options.
 */
export function collectFieldEntries(root: ParentNode = document): FieldEntry[] {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(FIELD_SELECTOR));
  const entries: FieldEntry[] = [];
  const seen = new Set<HTMLElement>();
  const radioGroups = new Map<string, HTMLInputElement[]>();

  for (const el of elements) {
    if (seen.has(el)) continue;
    seen.add(el);

    if (el instanceof HTMLInputElement && SKIP_INPUT_TYPES.has(el.type)) continue;
    if (!isEditable(el) && isDisabledOrReadonly(el)) continue;
    if (!isVisible(el)) continue;

    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const key = el.name || ensureFieldId(el);
      const group = radioGroups.get(key);
      if (group) group.push(el);
      else radioGroups.set(key, [el]);
      continue;
    }

    entries.push({ el, descriptor: describeField(el) });
  }

  for (const [name, group] of radioGroups) {
    const first = group[0];
    if (!first) continue;
    const id = ensureFieldId(first);
    for (const radio of group) radio.setAttribute('data-diggy-field-id', id);
    entries.push({
      el: first,
      descriptor: {
        id,
        tag: 'input',
        type: 'radio',
        name: name.startsWith('diggy-field-') ? undefined : name,
        label: deriveLabel(first) || undefined,
        ariaLabel: first.getAttribute('aria-label') ?? undefined,
        required: group.some((radio) => radio.required) || undefined,
        options: group.map((radio) => radio.value).filter(Boolean),
      },
    });
  }

  return entries;
}

/** Convenience wrapper: just the descriptors, as consumed by the LLM. */
export function scanFields(root: ParentNode = document): FieldDescriptor[] {
  return collectFieldEntries(root).map((entry) => entry.descriptor);
}

/** Resolve the element a descriptor id refers to. */
export function resolveFieldElement(fieldId: string): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(fieldId) : fieldId;
  const stamped = document.querySelector<HTMLElement>(`[data-diggy-field-id="${escaped}"]`);
  if (stamped) return stamped;
  return document.getElementById(fieldId);
}
