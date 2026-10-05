/**
 * Form filler — "the hands".
 *
 * React/framework-safe value setting: we call the *native* value setter from the
 * element prototype (so React's synthetic event system sees the change), then
 * dispatch `input` + `change` (and `focus`/`blur`) exactly like a user typing.
 * Handles inputs, textareas, selects, radios, checkboxes, date fields,
 * `[contenteditable]` and file inputs (via DataTransfer).
 *
 * It NEVER submits a form.
 */
import type { FillInstruction } from '@diggy/shared';
import { resolveFieldElement } from './dom-scanner';

export interface FillOutcome {
  fieldId: string;
  ok: boolean;
  reason?: string;
}

function isInput(el: HTMLElement | null): el is HTMLInputElement {
  return typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement;
}

/* ------------------------------------------------------------------ *
 * Existing value setter (React-safe)
 * ------------------------------------------------------------------ */

function setNativeValue(el: HTMLElement, value: string): void {
  const prototype =
    isInput(el) && el.tagName !== 'TEXTAREA'
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) descriptor.set.call(el, value);
  else (el as HTMLInputElement).value = value;
}

function setNativeChecked(el: HTMLInputElement, checked: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  if (descriptor?.set) descriptor.set.call(el, checked);
  else el.checked = checked;
}

/* ------------------------------------------------------------------ *
 * Event dispatch
 * ------------------------------------------------------------------ */

type DispatchType = 'input' | 'change' | 'focus' | 'blur' | 'click';

function dispatch(el: HTMLElement, type: DispatchType): void {
  if (type === 'click') {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return;
  }
  if (type === 'focus' || type === 'blur') {
    el.dispatchEvent(new FocusEvent(type, { bubbles: false }));
    return;
  }
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

/* ------------------------------------------------------------------ *
 * Value coercion helpers
 * ------------------------------------------------------------------ */

function isTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off';
}

function toDateValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;
  return date.toISOString().slice(0, 10);
}

function toDateTimeLocalValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return trimmed.slice(0, 16);
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;
  return date.toISOString().slice(0, 16);
}

function matchOption(options: HTMLOptionElement[], value: string): HTMLOptionElement | undefined {
  const target = value.trim().toLowerCase();
  return (
    options.find((option) => option.value === value) ??
    options.find((option) => option.value.toLowerCase() === target) ??
    options.find((option) => (option.textContent ?? '').trim().toLowerCase() === target) ??
    options.find((option) => (option.textContent ?? '').trim().toLowerCase().includes(target))
  );
}

function setSelectValue(select: HTMLSelectElement, value: string): boolean {
  const option = matchOption(Array.from(select.options), value);
  if (!option) return false;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(select, option.value);
  else select.value = option.value;
  return true;
}

function setContentEditable(el: HTMLElement, value: string): void {
  el.focus();
  el.textContent = value;
  dispatch(el, 'input');
}

/* ------------------------------------------------------------------ *
 * File attachment
 * ------------------------------------------------------------------ */

function dataUrlToFile(dataUrl: string, name: string, mime?: string): File | null {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) return null;
  const meta = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const match = /data:([^;]+)(;base64)?/.exec(meta);
  const type = mime ?? match?.[1] ?? 'application/octet-stream';
  const isBase64 = Boolean(match?.[2]);
  const view = isBase64 ? base64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
  const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  return new File([buffer], name, { type });
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Attach a file (from a base64/data URL) to a file input via DataTransfer. */
export function attachFile(fieldId: string, dataUrl: string, fileName = 'resume.pdf'): boolean {
  const el = resolveFieldElement(fieldId);
  if (!isInput(el) || el.type !== 'file') return false;
  const file = dataUrlToFile(dataUrl, fileName);
  if (!file) return false;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  el.files = transfer.files;
  dispatch(el, 'input');
  dispatch(el, 'change');
  return true;
}

/* ------------------------------------------------------------------ *
 * Fill
 * ------------------------------------------------------------------ */

function fillRadioGroup(el: HTMLInputElement, fieldId: string, value: string): FillOutcome {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(fieldId) : fieldId;
  const group = Array.from(
    document.querySelectorAll<HTMLInputElement>(`[data-diggy-field-id="${escaped}"]`),
  ).filter((radio) => radio.type === 'radio');
  const radios = group.length > 0 ? group : [el];
  const target = value.trim().toLowerCase();
  const labelOf = (radio: HTMLInputElement): string =>
    (radio.labels?.[0]?.textContent ?? '').trim().toLowerCase();

  const chosen =
    radios.find((radio) => radio.value === value) ??
    radios.find((radio) => radio.value.toLowerCase() === target) ??
    radios.find((radio) => labelOf(radio) === target) ??
    radios[0];
  if (!chosen) return { fieldId, ok: false, reason: 'radio-not-found' };
  chosen.focus();
  if (!chosen.checked) chosen.click();
  else setNativeChecked(chosen, true);
  dispatch(chosen, 'input');
  dispatch(chosen, 'change');
  chosen.blur();
  return { fieldId, ok: true };
}

export function fillField(instruction: FillInstruction): FillOutcome {
  const { fieldId, value } = instruction;
  const el = resolveFieldElement(fieldId);
  if (!el) return { fieldId, ok: false, reason: 'not-found' };

  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus();

  try {
    if (isInput(el)) {
      if (el.type === 'file') {
        if (value.startsWith('data:')) {
          return attachFile(fieldId, value) ? { fieldId, ok: true } : { fieldId, ok: false, reason: 'file-attach-failed' };
        }
        return { fieldId, ok: false, reason: 'file-needs-data-url' };
      }
      if (el.type === 'radio') return fillRadioGroup(el, fieldId, value);
      if (el.type === 'checkbox') {
        const desired = isTruthy(value);
        if (el.checked !== desired) el.click();
        else setNativeChecked(el, desired);
        dispatch(el, 'input');
        dispatch(el, 'change');
        return { fieldId, ok: true };
      }
      if (el.type === 'date') setNativeValue(el, toDateValue(value));
      else if (el.type === 'datetime-local') setNativeValue(el, toDateTimeLocalValue(value));
      else setNativeValue(el, value);
      dispatch(el, 'input');
      dispatch(el, 'change');
      return { fieldId, ok: true };
    }

    if (el.tagName === 'TEXTAREA') {
      setNativeValue(el, value);
      dispatch(el, 'input');
      dispatch(el, 'change');
      return { fieldId, ok: true };
    }

    if (el instanceof HTMLSelectElement) {
      const ok = setSelectValue(el, value);
      dispatch(el, 'input');
      dispatch(el, 'change');
      return ok ? { fieldId, ok: true } : { fieldId, ok: false, reason: 'option-not-found' };
    }

    if (el.isContentEditable) {
      setContentEditable(el, value);
      dispatch(el, 'change');
      return { fieldId, ok: true };
    }

    return { fieldId, ok: false, reason: 'unsupported-element' };
  } catch (error) {
    return { fieldId, ok: false, reason: error instanceof Error ? error.message : 'fill-error' };
  } finally {
    dispatch(el, 'blur');
  }
}

/** Apply many fill instructions. Returns how many landed and the skipped ids. */
export function fillFields(instructions: FillInstruction[]): { filled: number; skipped: string[] } {
  const skipped: string[] = [];
  let filled = 0;
  for (const instruction of instructions) {
    const outcome = fillField(instruction);
    if (outcome.ok) filled += 1;
    else skipped.push(outcome.fieldId);
  }
  return { filled, skipped };
}

/** Guard used everywhere: Diggy never auto-submits. */
export const NEVER_SUBMIT = true;

export { setNativeValue, setNativeChecked, dispatch };
