/**
 * WatchPanel — "watch the web for me" dashboard for the Diggy side panel.
 *
 * Lets the user keep an eye on job boards, opportunity pages and results pages.
 * Each watch is persisted through `src/watches` (chrome.storage.local); the
 * background worker polls them every few minutes and raises a notification the
 * moment the page changes or the configured keyword shows up.
 *
 * This panel only *manages* the watch list — it never fetches pages itself. It
 * loads the list, offers a compact "new watch" composer, and lets the user
 * enable/disable, check-now (best-effort via the `diggy:watch-check` message) or
 * delete each watch.
 *
 * Shell contract (shared with RemindersPanel / PagePanel / VaultPanel): a
 * `flex h-full min-h-0 flex-1 flex-col` root, a compact header row with a title
 * badge + ghost ✕ close, the always-visible composer outside the scroll region,
 * and exactly one `flex-1 min-h-0 overflow-y-auto` scroll region for the list.
 *
 * The coordinator wires this into `App.tsx`; this module never imports it.
 */
import { useCallback, useEffect, useState } from 'react';
import { cn, SketchBadge, SketchButton, SketchCard, SketchInput, SketchToggle } from '@diggy/ui';
import {
  addWatch,
  getWatches,
  MAX_WATCHES,
  makeWatchId,
  removeWatch,
  updateWatch,
  type Watch,
} from '../../src/watches';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Re-read the stored list periodically so background updates show up. */
const REFRESH_MS = 30_000;
/** Re-render relative "checked …" labels on a slow clock. */
const CLOCK_MS = 30_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Human relative label for when a watch was last polled. */
function formatChecked(lastCheckedAt: string | undefined, now: number): string {
  if (!lastCheckedAt) return 'not checked yet';
  const checked = new Date(lastCheckedAt).getTime();
  if (Number.isNaN(checked)) return 'not checked yet';

  const abs = Math.max(0, now - checked);
  if (abs < MINUTE) return 'checked <1m ago';

  let magnitude = `${Math.round(abs / MINUTE)}m`;
  if (abs >= DAY) magnitude = `${Math.round(abs / DAY)}d`;
  else if (abs >= HOUR) magnitude = `${Math.round(abs / HOUR)}h`;

  return `checked ${magnitude} ago`;
}

/** Absolute, locale-aware tooltip for `lastCheckedAt`. */
function absoluteChecked(lastCheckedAt: string | undefined): string {
  if (!lastCheckedAt) return 'Not checked yet';
  const date = new Date(lastCheckedAt);
  if (Number.isNaN(date.getTime())) return 'Not checked yet';
  return `Last checked ${date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/** True only for absolute http(s) URLs. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Watch row
 * ------------------------------------------------------------------ */

interface WatchRowProps {
  watch: Watch;
  now: number;
  onToggle: (watch: Watch, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

function WatchRow({ watch, now, onToggle, onDelete }: WatchRowProps): JSX.Element {
  const [checking, setChecking] = useState(false);

  const checkNow = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      await browser.runtime.sendMessage({ type: 'diggy:watch-check', id: watch.id });
    } catch {
      /* best-effort — the background may be asleep or the worker absent. */
    } finally {
      setChecking(false);
    }
  }, [watch.id]);

  return (
    <SketchCard tone="paper" accent="teal" className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-sketch text-sm font-semibold text-ink" title={watch.label}>
            {watch.label}
          </p>
          <p className="truncate text-[11px] text-ink-500" title={watch.url}>
            {watch.url}
          </p>
        </div>
        <SketchButton
          size="sm"
          variant="ghost"
          accent="red"
          aria-label={`Delete watch "${watch.label}"`}
          title="Delete"
          className="w-8 shrink-0 px-0"
          onClick={() => onDelete(watch.id)}
        >
          ✕
        </SketchButton>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <SketchBadge accent="sky" size="sm" title={absoluteChecked(watch.lastCheckedAt)}>
          {formatChecked(watch.lastCheckedAt, now)}
        </SketchBadge>
        {watch.keyword ? (
          <SketchBadge accent="gold" size="sm" variant="outline" title={`Keyword: ${watch.keyword}`}>
            🔑 {watch.keyword}
          </SketchBadge>
        ) : null}
        {!watch.enabled ? (
          <SketchBadge accent="amber" size="sm">
            paused
          </SketchBadge>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2">
        <SketchToggle
          size="sm"
          accent="green"
          checked={watch.enabled}
          label={watch.enabled ? 'Watching' : 'Paused'}
          onCheckedChange={(next) => onToggle(watch, next)}
        />
        <SketchButton
          size="sm"
          variant="paper"
          accent="violet"
          loading={checking}
          title="Ask Diggy to check this page right now"
          className="shrink-0 whitespace-nowrap"
          onClick={() => void checkNow()}
        >
          Check now
        </SketchButton>
      </div>
    </SketchCard>
  );
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function WatchPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());

  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [keyword, setKeyword] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* --- data --------------------------------------------------------- */

  const refresh = useCallback(async (): Promise<void> => {
    setWatches(await getWatches());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  /* --- mutations ---------------------------------------------------- */

  const handleAdd = useCallback(async (): Promise<void> => {
    const cleanLabel = label.trim();
    const cleanUrl = url.trim();
    const cleanKeyword = keyword.trim();

    if (!cleanLabel) {
      setError('Give this watch a label, e.g. “Naukri — frontend”.');
      return;
    }
    if (!isHttpUrl(cleanUrl)) {
      setError('Enter a valid http(s) URL to watch.');
      return;
    }

    const watch: Watch = {
      id: makeWatchId(),
      label: cleanLabel,
      url: cleanUrl,
      keyword: cleanKeyword || undefined,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    setAdding(true);
    try {
      const next = await addWatch(watch);
      setWatches(next);
      setLabel('');
      setUrl('');
      setKeyword('');
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `You can watch at most ${MAX_WATCHES} sites.`);
    } finally {
      setAdding(false);
    }
  }, [label, url, keyword]);

  const handleToggle = useCallback(
    async (watch: Watch, enabled: boolean): Promise<void> => {
      const next = await updateWatch(watch.id, { enabled });
      setWatches(next);
    },
    [],
  );

  const handleDelete = useCallback(async (id: string): Promise<void> => {
    const next = await removeWatch(id);
    setWatches(next);
  }, []);

  /* --- derived ------------------------------------------------------ */

  const canAdd = label.trim().length > 0 && url.trim().length > 0;
  const atLimit = watches.length >= MAX_WATCHES;

  /* --- render ------------------------------------------------------- */

  return (
    <div className="diggy-root diggy-panel diggy-panel-enter flex h-full min-h-0 flex-1 flex-col bg-paper text-sm text-ink">
      <header className="diggy-panel-header flex shrink-0 items-center justify-between gap-2 border-b-2 border-ink/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SketchBadge accent="teal" size="md" dot className="diggy-panel-title">
            Watching
          </SketchBadge>
          <SketchBadge accent={atLimit ? 'amber' : 'green'} size="sm">
            {watches.length}/{MAX_WATCHES}
          </SketchBadge>
        </div>
        <SketchButton
          size="sm"
          variant="ghost"
          aria-label="Close watch panel"
          title="Close"
          className="w-8 shrink-0 px-0"
          onClick={onClose}
        >
          ✕
        </SketchButton>
      </header>

      {/* Helper line — always visible, outside the scroll region. */}
      <p className="shrink-0 px-3 pt-2 font-sketch text-[11px] leading-snug text-ink-500">
        Diggy checks these in the background every few minutes and pings you the moment a page changes
        or your keyword shows up. 👀
      </p>

      {/* New watch composer */}
      <div className="shrink-0 px-3 pb-2 pt-2">
        <SketchCard tone="paper" accent="teal" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-sketch text-sm font-semibold text-ink-700">New watch</span>
            {atLimit ? (
              <SketchBadge accent="amber" size="sm">
                limit reached
              </SketchBadge>
            ) : null}
          </div>

          <SketchInput
            label="Label"
            accent="teal"
            placeholder="Naukri — frontend"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleAdd();
              }
            }}
          />

          <SketchInput
            label="URL"
            accent="teal"
            type="url"
            inputMode="url"
            placeholder="https://www.naukri.com/…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleAdd();
              }
            }}
          />

          <SketchInput
            label="Keyword (optional)"
            accent="teal"
            placeholder="React, intern, results…"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleAdd();
              }
            }}
          />

          {error ? (
            <p role="alert" className="break-words font-sketch text-xs text-crayon-red-deep">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <SketchButton
              size="sm"
              variant="accent"
              accent="teal"
              loading={adding}
              disabled={!canAdd || atLimit}
              className="shrink-0 whitespace-nowrap"
              onClick={() => void handleAdd()}
            >
              ＋ Watch
            </SketchButton>
          </div>
        </SketchCard>
      </div>

      {/* Watch list — the single scroll region. */}
      <div className="diggy-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-3 pb-3">
        {watches.length === 0 ? (
          <SketchCard tone="muted" className="space-y-1 text-center">
            <p className="font-sketch text-sm text-ink-700">
              Nothing watched yet — add a job or results page and Diggy will keep an eye on it. 👀
            </p>
            <p className="font-sketch text-[11px] leading-snug text-ink-500">
              Give it a label and a URL above; add a keyword to hear about one specific thing.
            </p>
          </SketchCard>
        ) : (
          watches.map((watch) => (
            <WatchRow
              key={watch.id}
              watch={watch}
              now={now}
              onToggle={(item, enabled) => void handleToggle(item, enabled)}
              onDelete={(id) => void handleDelete(id)}
            />
          ))
        )}

        {atLimit ? (
          <p className={cn('px-1 pt-1 text-center font-sketch text-[11px] leading-snug text-ink-500')}>
            You're watching the most Diggy can handle ({MAX_WATCHES} sites). Delete one to add another.
          </p>
        ) : null}
      </div>
    </div>
  );
}
