/**
 * PagePanel — "what's running on the web right now".
 *
 * A self-contained side-panel view that shows the live active tab, lets the
 * user scan the current page's text + form fields, ask Diggy to summarise it,
 * and check whether the local crawler service and the desktop bridge are up.
 *
 * Shell contract (shared with VaultPanel / RemindersPanel): a
 * `flex h-full min-h-0 flex-1 flex-col` root, a compact header row with a title
 * badge + ghost ✕ close, and one `flex-1 min-h-0 overflow-y-auto` scroll region —
 * so it drops straight into the ~400px side panel below App.tsx's tab bar.
 *
 * It talks to the rest of the extension only through existing helpers:
 *   - `callContent`      → runs `readPage` on the ACTIVE tab's content script
 *   - `getBridgeStatus`  → asks the background for the desktop link state
 *   - `getSettings`      → reads the configured crawler URL
 *
 * The coordinator wires this into `App.tsx`; this module must not import it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn, SketchBadge, SketchButton, SketchCard, ThinkingDots } from '@diggy/ui';
import type { FieldDescriptor, PageContext } from '@diggy/shared';
import { callContent, getBridgeStatus } from '../../src/messages';
import { getSettings } from '../../src/storage';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** How often to re-read the active tab (plus event-driven refreshes). */
const ACTIVE_TAB_POLL_MS = 3000;
/** Abort the crawler health probe after this long. */
const CRAWLER_TIMEOUT_MS = 2500;
/** Show at most this many field labels. */
const MAX_FIELD_LABELS = 12;
/** Show at most this many characters of page text. */
const MAX_TEXT_CHARS = 600;
/** Background prompt used by the "Summarise with Diggy" button. */
const SUMMARISE_PROMPT = 'Summarise this page in 2 short sentences using the readPage tool.';

/* ------------------------------------------------------------------ *
 * Types & helpers
 * ------------------------------------------------------------------ */

interface ActiveTab {
  id: number | null;
  title: string;
  url: string;
  favIconUrl: string;
}

interface ScanState {
  loading: boolean;
  error: string | null;
  page: PageContext | null;
}

interface ServicesState {
  checking: boolean;
  crawlerUrl: string;
  crawlerUp: boolean;
  bridgeConnected: boolean;
  bridgeUrl: string;
}

const INITIAL_SERVICES: ServicesState = {
  checking: true,
  crawlerUrl: '',
  crawlerUp: false,
  bridgeConnected: false,
  bridgeUrl: '',
};

/**
 * Pages the browser itself owns (settings, new tab, web store, other
 * extensions) where content scripts are never injected.
 */
function isRestrictedUrl(url: string): boolean {
  if (!url) return false;
  return /^(chrome|edge|brave|about|devtools|view-source|chrome-extension|moz-extension):/i.test(
    url,
  );
}

/** Turn an opaque content-script failure into a friendly, actionable message. */
function friendlyContentError(error: unknown, url: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const blockedByPage = isRestrictedUrl(url);
  const looksUnreachable =
    /receiving end does not exist|could not establish connection|no response|message port closed|no active tab/i.test(
      raw,
    );
  if (blockedByPage || looksUnreachable) {
    return 'Diggy can’t read this page. Browser pages (chrome://, the new-tab page, the Web Store) block content scripts — open a normal website and try again.';
  }
  return `Couldn’t read this page: ${raw}`;
}

/** A human label for one form field, falling back through the descriptor. */
function fieldLabel(field: FieldDescriptor): string {
  return (
    field.label?.trim() ||
    field.placeholder?.trim() ||
    field.name?.trim() ||
    field.ariaLabel?.trim() ||
    field.type?.trim() ||
    field.tag ||
    'field'
  );
}

/** Probe the crawler service's `/health` endpoint with a hard timeout. */
async function checkCrawler(url: string): Promise<boolean> {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) return false;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), CRAWLER_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/health`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Track the active tab in the last-focused window. Re-reads on tab activation,
 * tab updates and a slow interval so the widget stays live.
 */
function useActiveTab(): ActiveTab | null {
  const [tab, setTab] = useState<ActiveTab | null>(null);

  const read = useCallback(async () => {
    try {
      const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const active = tabs[0];
      if (!active) {
        setTab(null);
        return;
      }
      setTab({
        id: active.id ?? null,
        title: active.title ?? '',
        url: active.url ?? '',
        favIconUrl: active.favIconUrl ?? '',
      });
    } catch {
      setTab(null);
    }
  }, []);

  useEffect(() => {
    void read();

    const handleChange = (): void => {
      void read();
    };
    browser.tabs.onActivated.addListener(handleChange);
    browser.tabs.onUpdated.addListener(handleChange);
    const interval = window.setInterval(handleChange, ACTIVE_TAB_POLL_MS);

    return () => {
      browser.tabs.onActivated.removeListener(handleChange);
      browser.tabs.onUpdated.removeListener(handleChange);
      window.clearInterval(interval);
    };
  }, [read]);

  return tab;
}

/* ------------------------------------------------------------------ *
 * Small presentational pieces
 * ------------------------------------------------------------------ */

function Favicon({ url, className }: { url: string; className?: string }): JSX.Element {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [url]);

  if (!url || broken) {
    return (
      <span
        aria-hidden="true"
        className={cn('grid place-items-center bg-paper-200 text-[12px]', className)}
      >
        🌐
      </span>
    );
  }

  return (
    <img
      src={url}
      alt=""
      className={cn('object-contain', className)}
      onError={() => setBroken(true)}
    />
  );
}

/** Friendly, specific empty state used across the page cards. */
function EmptyState({
  icon,
  text,
  className,
}: {
  icon: string;
  text: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-sketch-sm border-2 border-dashed border-ink/20 bg-paper-100/40 px-2.5 py-2',
        className,
      )}
    >
      <span aria-hidden="true" className="text-sm leading-5">
        {icon}
      </span>
      <p className="min-w-0 font-sketch text-[11px] leading-snug text-ink-500">{text}</p>
    </div>
  );
}

function StatusRow({
  label,
  ok,
  detail,
  pending,
}: {
  label: string;
  ok: boolean;
  detail: string;
  pending: boolean;
}): JSX.Element {
  const accent = pending ? 'amber' : ok ? 'green' : 'red';
  const state = pending ? '…' : ok ? 'up' : 'down';
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <SketchBadge accent={accent} size="sm" dot>
          {state}
        </SketchBadge>
        <span className="whitespace-nowrap font-semibold text-ink-700">{label}</span>
      </div>
      <span className="min-w-0 truncate text-right text-[11px] text-ink-500" title={detail}>
        {detail}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function PagePanel({ onClose }: { onClose: () => void }): JSX.Element {
  const tab = useActiveTab();
  const restricted = isRestrictedUrl(tab?.url ?? '');

  const [scan, setScan] = useState<ScanState>({ loading: false, error: null, page: null });
  const [summarising, setSummarising] = useState(false);
  const [summaryNote, setSummaryNote] = useState<string | null>(null);
  const [services, setServices] = useState<ServicesState>(INITIAL_SERVICES);

  /* --- services ----------------------------------------------------- */

  const refreshServices = useCallback(async () => {
    setServices((current) => ({ ...current, checking: true }));

    let crawlerUrl = '';
    try {
      const settings = await getSettings();
      crawlerUrl = settings.crawlerUrl;
    } catch {
      crawlerUrl = '';
    }

    const bridgePromise = getBridgeStatus()
      .then((status) => ({ connected: status.connected, url: status.url }))
      .catch(() => ({ connected: false, url: '' }));

    const [crawlerUp, bridge] = await Promise.all([checkCrawler(crawlerUrl), bridgePromise]);

    setServices({
      checking: false,
      crawlerUrl,
      crawlerUp,
      bridgeConnected: bridge.connected,
      bridgeUrl: bridge.url,
    });
  }, []);

  useEffect(() => {
    void refreshServices();
  }, [refreshServices]);

  /* --- scan --------------------------------------------------------- */

  const scanPage = useCallback(async () => {
    setScan({ loading: true, error: null, page: null });
    try {
      const page = await callContent('readPage', { includeFields: true });
      setScan({ loading: false, error: null, page });
    } catch (error) {
      setScan({ loading: false, error: friendlyContentError(error, tab?.url ?? ''), page: null });
    }
  }, [tab?.url]);

  /* --- summarise ---------------------------------------------------- */

  const summarise = useCallback(async () => {
    setSummarising(true);
    setSummaryNote(null);
    try {
      await browser.runtime.sendMessage({ type: 'diggy:ask', text: SUMMARISE_PROMPT });
      setSummaryNote('Asked Diggy — the summary appears in the bot’s bubble above it.');
    } catch (error) {
      setSummaryNote(
        `Couldn’t reach the Diggy background: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSummarising(false);
    }
  }, []);

  /* --- derived ------------------------------------------------------ */

  const fieldLabels = useMemo(() => {
    const fields = scan.page?.fields ?? [];
    return fields.slice(0, MAX_FIELD_LABELS).map(fieldLabel);
  }, [scan.page]);

  const fieldCount = scan.page?.fields?.length ?? 0;
  const hiddenFields = Math.max(0, fieldCount - MAX_FIELD_LABELS);

  const textPreview = useMemo(() => {
    const text = scan.page?.text ?? '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    return collapsed.length > MAX_TEXT_CHARS
      ? `${collapsed.slice(0, MAX_TEXT_CHARS)}…`
      : collapsed;
  }, [scan.page]);

  /* --- render ------------------------------------------------------- */

  return (
    <div className="diggy-root diggy-panel diggy-panel-enter flex h-full min-h-0 flex-1 flex-col bg-paper text-sm text-ink">
      <header className="diggy-panel-header flex shrink-0 items-center justify-between gap-2 border-b-2 border-ink/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SketchBadge accent="sky" size="md" dot className="diggy-panel-title">
            Live tab
          </SketchBadge>
          <SketchBadge accent={!tab ? 'amber' : restricted ? 'amber' : 'green'} size="sm">
            {!tab ? 'idle' : restricted ? 'restricted' : 'live'}
          </SketchBadge>
        </div>
        <SketchButton
          size="sm"
          variant="ghost"
          aria-label="Close panel"
          title="Close"
          className="w-8 shrink-0 px-0"
          onClick={onClose}
        >
          ✕
        </SketchButton>
      </header>

      <div className="diggy-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-3 py-3">
        {/* Active tab ------------------------------------------------- */}
        <SketchCard tone="accent" accent="sky" className="space-y-2">
          <span className="diggy-panel-title block text-xs font-semibold text-ink-500">Active tab</span>

          {tab ? (
            <div className="flex items-start gap-2">
              <Favicon url={tab.favIconUrl} className="mt-0.5 h-5 w-5 shrink-0 rounded-sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-ink-700" title={tab.title || undefined}>
                  {tab.title || '(untitled)'}
                </p>
                <p className="truncate text-[11px] text-ink-500" title={tab.url || undefined}>
                  {tab.url || '(no url)'}
                </p>
              </div>
            </div>
          ) : (
            <EmptyState
              icon="🪟"
              text="No active tab in this window yet — click into a normal website and Diggy will pick it up."
            />
          )}

          {tab && restricted ? (
            <p className="text-[11px] leading-snug text-ink-500">
              Browser pages block content scripts, so scanning is unavailable here.
            </p>
          ) : null}
        </SketchCard>

        {/* Scan ------------------------------------------------------- */}
        <SketchCard tone="paper" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="diggy-panel-title text-xs font-semibold text-ink-500">Page scan</span>
            <SketchButton
              size="sm"
              variant="accent"
              accent="violet"
              loading={scan.loading}
              aria-label="Scan the current page"
              className="shrink-0 whitespace-nowrap"
              onClick={() => void scanPage()}
            >
              Scan page
            </SketchButton>
          </div>

          {scan.error ? (
            <p className="break-words rounded-sketch-sm bg-crayon-red-soft/60 px-2 py-1 text-[12px] leading-snug text-crayon-red-deep">
              {scan.error}
            </p>
          ) : null}

          {scan.loading ? (
            <div className="flex items-center gap-2 text-ink-500">
              <ThinkingDots size="sm" />
              <span>Reading the page…</span>
            </div>
          ) : null}

          {scan.page ? (
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink-700" title={scan.page.title || undefined}>
                  {scan.page.title || '(untitled)'}
                </p>
                <p className="truncate text-[11px] text-ink-500" title={scan.page.url || undefined}>
                  {scan.page.url || '(no url)'}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <SketchBadge accent={fieldCount > 0 ? 'teal' : 'amber'} size="sm">
                  {fieldCount} field{fieldCount === 1 ? '' : 's'}
                </SketchBadge>
              </div>

              {fieldLabels.length > 0 ? (
                <ul className="flex flex-wrap gap-1">
                  {fieldLabels.map((label, index) => (
                    <li
                      key={`${label}-${index}`}
                      className="max-w-full truncate rounded-sketch-sm bg-paper-200 px-2 py-0.5 text-[11px] text-ink-700"
                      title={label}
                    >
                      {label}
                    </li>
                  ))}
                  {hiddenFields > 0 ? (
                    <li className="rounded-sketch-sm bg-paper-100 px-2 py-0.5 text-[11px] text-ink-500">
                      +{hiddenFields} more
                    </li>
                  ) : null}
                </ul>
              ) : (
                <EmptyState
                  icon="🧾"
                  text="No form fields on this page — there is nothing for Diggy to fill."
                />
              )}

              <div>
                <span className="diggy-panel-title block text-[10px] font-semibold text-ink-500">
                  Page text
                </span>
                <div className="diggy-scrollbar mt-1 max-h-40 overflow-y-auto overflow-x-hidden whitespace-pre-wrap rounded-sketch-sm bg-paper-100 p-2 text-[11px] leading-relaxed text-ink-700">
                  {textPreview || 'No readable text found on this page.'}
                </div>
              </div>
            </div>
          ) : null}

          {!scan.page && !scan.loading && !scan.error ? (
            <EmptyState
              icon="🔍"
              text="Nothing scanned yet — hit Scan page to see the title, detected fields and a text snippet."
            />
          ) : null}
        </SketchCard>

        {/* Summarise -------------------------------------------------- */}
        <SketchCard tone="paper" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="diggy-panel-title text-xs font-semibold text-ink-500">Ask Diggy</span>
            <SketchButton
              size="sm"
              variant="ink"
              accent="amber"
              loading={summarising}
              title="Ask Diggy to summarise this page in its bubble"
              className="shrink-0 whitespace-nowrap"
              onClick={() => void summarise()}
            >
              Summarise with Diggy
            </SketchButton>
          </div>
          {summaryNote ? (
            <p className="break-words text-[12px] leading-snug text-ink-700">{summaryNote}</p>
          ) : (
            <p className="text-[11px] leading-snug text-ink-500">
              Diggy reads the page and answers in its bubble — look above the bot for the summary.
            </p>
          )}
        </SketchCard>

        {/* Services --------------------------------------------------- */}
        <SketchCard tone="muted" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="diggy-panel-title text-xs font-semibold text-ink-500">Services</span>
            <SketchButton
              size="sm"
              variant="ghost"
              loading={services.checking}
              aria-label="Re-check the crawler and desktop bridge"
              title="Re-check crawler + bridge"
              className="shrink-0 whitespace-nowrap"
              onClick={() => void refreshServices()}
            >
              Refresh
            </SketchButton>
          </div>
          <StatusRow
            label="Crawler"
            ok={services.crawlerUp}
            pending={services.checking}
            detail={services.crawlerUrl || 'not set'}
          />
          <StatusRow
            label="Desktop bridge"
            ok={services.bridgeConnected}
            pending={services.checking}
            detail={services.bridgeUrl || 'not connected'}
          />
        </SketchCard>
      </div>
    </div>
  );
}
