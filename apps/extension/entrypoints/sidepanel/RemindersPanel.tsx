/**
 * RemindersPanel — a self-contained reminders dashboard for the Diggy side panel.
 *
 * Owns its own data-loading lifecycle (initial fetch + a ~20s polling refresh +
 * a refresh after every mutation), renders pending/snoozed reminders sorted by
 * due date with a collapsed "completed" section, and provides a compact "new
 * reminder" composer. New reminders are persisted through `src/storage` and,
 * best-effort, handed to the background worker so it can (re)schedule the alarm
 * via the `diggy:reminder-schedule` message.
 *
 * The panel is intentionally standalone — it is wired into the app by the
 * coordinator and never imports `App.tsx`.
 *
 * Shell contract (shared with VaultPanel / PagePanel): a
 * `flex h-full min-h-0 flex-1 flex-col` root, a compact header row with a title
 * badge + ghost ✕ close, then the always-visible composer and a single
 * `flex-1 min-h-0 overflow-y-auto` scroll region for the reminder list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { InkBackground, SketchBadge, SketchButton, SketchCard, SketchInput, cn } from '@diggy/ui';
import type { AccentName } from '@diggy/ui';
import type { Reminder } from '@diggy/shared';
import { addReminder, getReminders, saveReminders, updateReminder } from '../../src/storage';
import { makeId, type ScheduleReminderMessage } from '../../src/messages';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const REFRESH_MS = 20_000;
const CLOCK_MS = 30_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ *
 * Time + label helpers
 * ------------------------------------------------------------------ */

/** Millisecond timestamp for a reminder's due date (Infinity when unparseable). */
function dueTime(reminder: Reminder): number {
  const value = new Date(reminder.dueAt).getTime();
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

/** Human relative label, e.g. "in 2h" / "10m ago". */
function formatRelative(dueAt: string, now: number): string {
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return 'no date';
  const diff = due - now;
  const abs = Math.abs(diff);

  if (abs < MINUTE) return diff >= 0 ? 'in <1m' : '<1m ago';

  let magnitude = `${Math.round(abs / MINUTE)}m`;
  if (abs >= DAY) magnitude = `${Math.round(abs / DAY)}d`;
  else if (abs >= HOUR) magnitude = `${Math.round(abs / HOUR)}h`;

  return diff >= 0 ? `in ${magnitude}` : `${magnitude} ago`;
}

/** Absolute, locale-aware due time. */
function formatAbsolute(dueAt: string): string {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return dueAt;
  return due.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format a Date for a `<input type="datetime-local">` value (local time). */
function toLocalInputValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function defaultDueInput(): string {
  return toLocalInputValue(new Date(Date.now() + HOUR));
}

function snoozeTenMinutes(): Date {
  return new Date(Date.now() + 10 * MINUTE);
}

function snoozeOneHour(): Date {
  return new Date(Date.now() + HOUR);
}

function snoozeTomorrowMorning(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date;
}

function sourceAccent(source: string): AccentName {
  const key = source.toLowerCase();
  if (key.includes('bridge') || key.includes('desktop')) return 'violet';
  if (key.includes('agent') || key.includes('chat')) return 'sky';
  if (key.includes('page') || key.includes('web')) return 'teal';
  return 'amber';
}

/* ------------------------------------------------------------------ *
 * Reminder row
 * ------------------------------------------------------------------ */

interface ReminderRowProps {
  reminder: Reminder;
  now: number;
  completed: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onSnooze: (reminder: Reminder, until: Date) => void;
  onDone: (id: string) => void;
  onDelete: (id: string) => void;
}

function ReminderRow({
  reminder,
  now,
  completed,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onSnooze,
  onDone,
  onDelete,
}: ReminderRowProps): JSX.Element {
  const overdue = !completed && reminder.status === 'pending' && dueTime(reminder) < now;
  const accent: AccentName = completed
    ? 'green'
    : overdue
      ? 'red'
      : reminder.status === 'snoozed'
        ? 'amber'
        : 'teal';
  const source = reminder.source?.trim() || 'local';

  return (
    <SketchCard
      tone={overdue ? 'accent' : 'paper'}
      accent={accent}
      padded={false}
      className={cn('p-2.5', overdue && 'border-crayon-red-deep')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {overdue ? (
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-crayon-red-deep"
              />
            ) : null}
            <span
              className={cn(
                'truncate font-sketch text-sm font-semibold',
                completed ? 'text-ink-400 line-through' : 'text-ink',
              )}
              title={reminder.title}
            >
              {reminder.title}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <SketchBadge accent={accent} size="sm" title={formatAbsolute(reminder.dueAt)}>
              {formatRelative(reminder.dueAt, now)}
            </SketchBadge>
            <span className="font-sketch text-[11px] text-ink-500">{formatAbsolute(reminder.dueAt)}</span>
            <SketchBadge accent={sourceAccent(source)} size="sm" variant="outline" title={`Source: ${source}`}>
              {source}
            </SketchBadge>
            {overdue ? (
              <SketchBadge accent="red" size="sm" dot>
                overdue
              </SketchBadge>
            ) : reminder.status === 'snoozed' ? (
              <SketchBadge accent="amber" size="sm">
                snoozed
              </SketchBadge>
            ) : null}
          </div>

          {reminder.notes ? (
            <p className="mt-1 truncate font-sketch text-[11px] text-ink-500" title={reminder.notes}>
              {reminder.notes}
            </p>
          ) : null}
        </div>

        {!completed ? (
          <div className="relative flex shrink-0 flex-col items-end">
            <div className="flex items-center gap-1">
              <SketchButton
                size="sm"
                variant="paper"
                accent="green"
                aria-label={`Mark "${reminder.title}" done`}
                title="Mark done"
                className="whitespace-nowrap"
                onClick={() => onDone(reminder.id)}
              >
                Done
              </SketchButton>
              <SketchButton
                size="sm"
                variant="paper"
                accent="amber"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Snooze this reminder"
                className="whitespace-nowrap"
                onClick={onToggleMenu}
              >
                Snooze
              </SketchButton>
              <SketchButton
                size="sm"
                variant="ghost"
                accent="red"
                aria-label={`Delete "${reminder.title}"`}
                title="Delete"
                className="w-8 px-0"
                onClick={() => onDelete(reminder.id)}
              >
                ✕
              </SketchButton>
            </div>

            {menuOpen ? (
              <>
                <button
                  type="button"
                  aria-label="Close snooze menu"
                  className="fixed inset-0 z-40 cursor-default bg-transparent"
                  onClick={onCloseMenu}
                />
                <div
                  role="menu"
                  aria-label="Snooze options"
                  className="absolute right-0 top-full z-50 mt-1 w-40 space-y-1 rounded-sketch-sm border-2 border-ink/80 bg-paper p-1.5 shadow-sketch-soft"
                >
                  <SketchButton
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start"
                    role="menuitem"
                    onClick={() => onSnooze(reminder, snoozeTenMinutes())}
                  >
                    +10 minutes
                  </SketchButton>
                  <SketchButton
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start"
                    role="menuitem"
                    onClick={() => onSnooze(reminder, snoozeOneHour())}
                  >
                    +1 hour
                  </SketchButton>
                  <SketchButton
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start"
                    role="menuitem"
                    onClick={() => onSnooze(reminder, snoozeTomorrowMorning())}
                  >
                    Tomorrow 9am
                  </SketchButton>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </SketchCard>
  );
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function RemindersPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());

  const [title, setTitle] = useState('');
  const [dueLocal, setDueLocal] = useState<string>(() => defaultDueInput());
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showDone, setShowDone] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState<string | null>(null);

  /* --- data ------------------------------------------------------------- */

  const refresh = useCallback(async (): Promise<void> => {
    setReminders(await getReminders());
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

  // Best-effort notification permission request on first mount.
  useEffect(() => {
    try {
      if (typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function') {
        void Notification.requestPermission().catch(() => undefined);
      }
    } catch {
      /* notifications unavailable — not fatal */
    }
  }, []);

  const scheduleAlarm = useCallback(async (reminder: Reminder): Promise<void> => {
    try {
      const message: ScheduleReminderMessage = { type: 'diggy:reminder-schedule', reminder };
      await browser.runtime.sendMessage(message);
    } catch {
      /* it is persisted in storage regardless of the background worker */
    }
  }, []);

  /* --- mutations -------------------------------------------------------- */

  const handleAdd = useCallback(async (): Promise<void> => {
    const cleanTitle = title.trim();
    if (!cleanTitle || !dueLocal) return;

    const parsed = new Date(dueLocal);
    if (Number.isNaN(parsed.getTime())) {
      setError('Pick a valid due date and time.');
      return;
    }

    const reminder: Reminder = {
      id: makeId('reminder'),
      title: cleanTitle,
      notes: notes.trim() || undefined,
      dueAt: parsed.toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: 'sidepanel',
    };

    setAdding(true);
    try {
      await addReminder(reminder);
      await scheduleAlarm(reminder);
      setTitle('');
      setNotes('');
      setDueLocal(defaultDueInput());
      setError(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the reminder.');
    } finally {
      setAdding(false);
    }
  }, [title, dueLocal, notes, scheduleAlarm, refresh]);

  const handleDone = useCallback(
    async (id: string): Promise<void> => {
      await updateReminder(id, { status: 'done' });
      await refresh();
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      const list = await getReminders();
      await saveReminders(list.filter((item) => item.id !== id));
      await refresh();
    },
    [refresh],
  );

  const handleSnooze = useCallback(
    async (reminder: Reminder, until: Date): Promise<void> => {
      setSnoozeOpen(null);
      const dueAt = until.toISOString();
      const updated = await updateReminder(reminder.id, { dueAt, status: 'snoozed' });
      await scheduleAlarm(updated ?? { ...reminder, dueAt, status: 'snoozed' });
      await refresh();
    },
    [scheduleAlarm, refresh],
  );

  /* --- derived ---------------------------------------------------------- */

  const active = useMemo(
    () => reminders.filter((item) => item.status !== 'done').sort((a, b) => dueTime(a) - dueTime(b)),
    [reminders],
  );

  const completed = useMemo(
    () => reminders.filter((item) => item.status === 'done').sort((a, b) => dueTime(b) - dueTime(a)),
    [reminders],
  );

  const overdueCount = useMemo(
    () => reminders.filter((item) => item.status === 'pending' && dueTime(item) < now).length,
    [reminders, now],
  );

  const canAdd = title.trim().length > 0 && dueLocal.length > 0;

  /* --- render ----------------------------------------------------------- */

  return (
    <InkBackground className="h-full min-h-0 flex-1" opacity={0.4} density={5}>
      <div className="diggy-root diggy-panel diggy-panel-enter flex h-full min-h-0 flex-1 flex-col text-ink">
        <header className="diggy-panel-header flex shrink-0 items-center justify-between gap-2 border-b-2 border-ink/10 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <SketchBadge accent="violet" size="md" dot className="diggy-panel-title">
              Reminders
            </SketchBadge>
            <SketchBadge accent={overdueCount > 0 ? 'red' : 'green'} size="sm">
              {active.length} active
            </SketchBadge>
          </div>
          <SketchButton
            size="sm"
            variant="ghost"
            aria-label="Close reminders"
            title="Close"
            className="w-8 shrink-0 px-0"
            onClick={onClose}
          >
            ✕
          </SketchButton>
        </header>

        {/* New reminder composer */}
        <div className="shrink-0 px-3 pb-2 pt-3">
          <SketchCard tone="paper" accent="teal" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-sketch text-sm font-semibold text-ink-700">New reminder</span>
              {overdueCount > 0 ? (
                <SketchBadge accent="red" size="sm" dot>
                  {overdueCount} overdue
                </SketchBadge>
              ) : null}
            </div>

            <SketchInput
              label="Title"
              accent="teal"
              placeholder="Take a walk…"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleAdd();
                }
              }}
            />

            <SketchInput
              label="Due"
              accent="teal"
              type="datetime-local"
              value={dueLocal}
              onChange={(event) => setDueLocal(event.target.value)}
            />

            <SketchInput
              label="Notes (optional)"
              accent="teal"
              placeholder="Extra detail…"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
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
                disabled={!canAdd}
                className="shrink-0 whitespace-nowrap"
                onClick={() => void handleAdd()}
              >
                + Add reminder
              </SketchButton>
            </div>
          </SketchCard>
        </div>

        {/* Reminder list */}
        <div className="diggy-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-3 pb-3">
          {active.length === 0 ? (
            <SketchCard tone="muted" padded className="space-y-1 text-center">
              <p className="font-sketch text-sm text-ink-700">Nothing pending — enjoy the calm. 🌤</p>
              <p className="font-sketch text-[11px] leading-snug text-ink-500">
                Add one above and Diggy will nudge you right when it's due.
              </p>
            </SketchCard>
          ) : (
            active.map((reminder) => (
              <ReminderRow
                key={reminder.id}
                reminder={reminder}
                now={now}
                completed={false}
                menuOpen={snoozeOpen === reminder.id}
                onToggleMenu={() => setSnoozeOpen((current) => (current === reminder.id ? null : reminder.id))}
                onCloseMenu={() => setSnoozeOpen(null)}
                onSnooze={(item, until) => void handleSnooze(item, until)}
                onDone={(id) => void handleDone(id)}
                onDelete={(id) => void handleDelete(id)}
              />
            ))
          )}

          {completed.length > 0 ? (
            <div className="space-y-2 pt-1">
              <button
                type="button"
                aria-expanded={showDone}
                onClick={() => setShowDone((value) => !value)}
                className={cn(
                  'font-sketch flex w-full items-center gap-1.5 rounded-sketch-sm border-2 border-ink/30',
                  'bg-paper-200/60 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink-700',
                  'transition-colors hover:bg-paper-200',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-ink/70',
                )}
              >
                <span aria-hidden="true">{showDone ? '▾' : '▸'}</span>
                Completed ({completed.length})
              </button>

              {showDone
                ? completed.map((reminder) => (
                    <ReminderRow
                      key={reminder.id}
                      reminder={reminder}
                      now={now}
                      completed
                      menuOpen={false}
                      onToggleMenu={() => undefined}
                      onCloseMenu={() => undefined}
                      onSnooze={() => undefined}
                      onDone={() => undefined}
                      onDelete={(id) => void handleDelete(id)}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </div>
      </div>
    </InkBackground>
  );
}
