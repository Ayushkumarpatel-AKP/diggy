/**
 * Form detector — groups scanned fields into forms / wizards and flags the
 * things that matter for autofill: required fields, the resume/cover-letter
 * file input, and the submit buttons (which we *never* click automatically).
 */
import type { FieldDescriptor } from '@diggy/shared';
import { collectFieldEntries, ensureFieldId } from './dom-scanner';

export interface DetectedSubmitButton {
  fieldId: string;
  text: string;
  kind: 'submit' | 'button';
  disabled: boolean;
}

export interface DetectedFileInput {
  fieldId: string;
  accept?: string;
  multiple: boolean;
}

export interface DetectedForm {
  id: string;
  name?: string;
  action?: string;
  method?: string;
  fields: FieldDescriptor[];
  requiredFieldIds: string[];
  fileInputs: DetectedFileInput[];
  submitButtons: DetectedSubmitButton[];
  /** Heuristic: does this form look like one step of a multi-step wizard? */
  isWizard: boolean;
  stepLabel?: string;
}

export interface FormDetection {
  url: string;
  forms: DetectedForm[];
  /** Fields that are not wrapped in a <form>. */
  orphanFields: FieldDescriptor[];
  isWizard: boolean;
  submitButtons: DetectedSubmitButton[];
}

const SUBMIT_TEXT_PATTERN =
  /(submit|send|apply|save|continue|next|finish|complete|register|sign\s?up|submit\s+application|proceed)/i;

const WIZARD_HINT_PATTERN = /(wizard|step|stepper|progress|multi-?step|stage)/i;

function formLabel(form: HTMLFormElement): string | undefined {
  const legend = form.querySelector('legend');
  const aria = form.getAttribute('aria-label');
  const heading = form.querySelector('h1, h2, h3');
  const text = (legend?.textContent ?? aria ?? heading?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function buttonText(el: HTMLElement): string {
  const value = el instanceof HTMLInputElement ? el.value : '';
  return (value || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function describeSubmitButton(el: HTMLElement): DetectedSubmitButton {
  const isSubmitInput = el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button');
  const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  return {
    fieldId: ensureFieldId(el),
    text: buttonText(el) || 'Submit',
    kind: isSubmitInput && el instanceof HTMLInputElement && el.type === 'button' ? 'button' : 'submit',
    disabled,
  };
}

function collectSubmitButtons(scope: ParentNode): DetectedSubmitButton[] {
  const candidates = Array.from(
    scope.querySelectorAll<HTMLElement>(
      'button, input[type="submit"], input[type="button"], [role="button"]',
    ),
  );
  return candidates
    .map((el) => describeSubmitButton(el))
    .filter((button) => SUBMIT_TEXT_PATTERN.test(button.text) || button.kind === 'submit');
}

function collectFileInputs(scope: ParentNode): DetectedFileInput[] {
  return Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="file"]')).map((el) => ({
    fieldId: ensureFieldId(el),
    accept: el.accept || undefined,
    multiple: el.multiple,
  }));
}

function looksLikeWizard(form: HTMLFormElement, stepCount: number): boolean {
  const attrs = `${form.className} ${form.id} ${form.getAttribute('data-step') ?? ''} ${
    form.getAttribute('aria-label') ?? ''
  }`;
  if (WIZARD_HINT_PATTERN.test(attrs)) return true;
  const visibleFieldsets = Array.from(form.querySelectorAll('fieldset')).filter(
    (fieldset) => !fieldset.disabled && fieldset.offsetParent !== null,
  );
  if (visibleFieldsets.length === 1 && form.querySelectorAll('fieldset').length > 1) return true;
  if (stepCount > 1) return true;
  return false;
}

/**
 * Group the page's fields into forms (plus orphan fields) and enrich each group
 * with required fields, file inputs and submit buttons.
 */
export function detectForms(root: ParentNode = document): FormDetection {
  const entries = collectFieldEntries(root);
  const forms = Array.from(root.querySelectorAll<HTMLFormElement>('form'));

  const byForm = new Map<HTMLFormElement, FieldDescriptor[]>();
  const orphanFields: FieldDescriptor[] = [];

  for (const entry of entries) {
    const form = entry.el.closest('form');
    if (form && forms.includes(form)) {
      const list = byForm.get(form);
      if (list) list.push(entry.descriptor);
      else byForm.set(form, [entry.descriptor]);
    } else {
      orphanFields.push(entry.descriptor);
    }
  }

  const stepCount = Math.max(1, byForm.size);
  const allSubmitButtons = collectSubmitButtons(root);

  const detectedForms: DetectedForm[] = [];
  for (const [form, fields] of byForm) {
    const submitButtons = collectSubmitButtons(form);
    detectedForms.push({
      id: form.id || ensureFieldId(form),
      name: form.getAttribute('name') ?? undefined,
      action: form.getAttribute('action') ?? undefined,
      method: form.getAttribute('method') ?? undefined,
      fields,
      requiredFieldIds: fields.filter((field) => field.required).map((field) => field.id),
      fileInputs: collectFileInputs(form),
      submitButtons,
      isWizard: looksLikeWizard(form, stepCount),
      stepLabel: formLabel(form),
    });
  }

  return {
    url: typeof location !== 'undefined' ? location.href : '',
    forms: detectedForms,
    orphanFields,
    isWizard: detectedForms.some((form) => form.isWizard),
    submitButtons: allSubmitButtons,
  };
}

/** All file inputs on the page (used to attach a resume). */
export function findFileInputs(root: ParentNode = document): DetectedFileInput[] {
  return collectFileInputs(root);
}
