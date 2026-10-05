/**
 * Throttled DOM observer.
 *
 * Created on every page but **silent by default**: mutations only mark the page
 * dirty. Reports are emitted solely when {@link DomObserver.requestReport} is
 * called (or while `setReporting(true)` is active) and are throttled so we never
 * spam the background worker.
 */
import { detectForms } from './form-detector';
import { scanFields } from './dom-scanner';

export interface DomMutationReport {
  at: number;
  fieldCount: number;
  formCount: number;
  isWizard: boolean;
}

export interface DomObserverOptions {
  /** Minimum gap between reports. Defaults to 1500ms. */
  throttleMs?: number;
  /** Called with a throttled report when reporting is enabled/requested. */
  onReport?: (report: DomMutationReport) => void;
}

export interface DomObserver {
  start(): void;
  stop(): void;
  /** Turn continuous reporting on/off. */
  setReporting(enabled: boolean): void;
  /** Emit a single report now (throttled) if the DOM changed since the last one. */
  requestReport(): void;
  isObserving(): boolean;
  isDirty(): boolean;
}

export function createDomObserver(options: DomObserverOptions = {}): DomObserver {
  const throttleMs = options.throttleMs ?? 1500;
  let observer: MutationObserver | null = null;
  let reporting = false;
  let dirty = false;
  let lastReportAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (): void => {
    if (!dirty || !options.onReport) return;
    dirty = false;
    lastReportAt = Date.now();
    let report: DomMutationReport = { at: lastReportAt, fieldCount: 0, formCount: 0, isWizard: false };
    try {
      const detection = detectForms();
      report = {
        at: lastReportAt,
        fieldCount: scanFields().length,
        formCount: detection.forms.length,
        isWizard: detection.isWizard,
      };
    } catch {
      /* never let a scan break the observer */
    }
    options.onReport(report);
  };

  const schedule = (): void => {
    if (timer) return;
    const elapsed = Date.now() - lastReportAt;
    const wait = Math.max(0, throttleMs - elapsed);
    timer = setTimeout(() => {
      timer = null;
      if (reporting) emit();
    }, wait);
  };

  return {
    start(): void {
      if (observer || typeof MutationObserver === 'undefined') return;
      observer = new MutationObserver(() => {
        dirty = true;
        if (reporting) schedule();
      });
      observer.observe(document.documentElement ?? document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['type', 'name', 'required', 'value', 'style', 'class'],
      });
    },
    stop(): void {
      observer?.disconnect();
      observer = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    setReporting(enabled: boolean): void {
      reporting = enabled;
      if (enabled) schedule();
    },
    requestReport(): void {
      if (!dirty) return;
      const elapsed = Date.now() - lastReportAt;
      if (elapsed >= throttleMs) emit();
      else schedule();
    },
    isObserving(): boolean {
      return observer !== null;
    },
    isDirty(): boolean {
      return dirty;
    },
  };
}
