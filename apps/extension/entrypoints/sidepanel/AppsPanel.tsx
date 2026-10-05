/**
 * AppsPanel — "Connected apps" (the Google Gmail + Calendar integration) for
 * the Diggy side panel.
 *
 * A self-contained view that walks the user through creating a Google Cloud
 * "Web application" OAuth client (with PKCE, so no client secret ships), links
 * the account through `src/google`, and lets them tune the background watcher
 * (Gmail / Calendar toggles + the Gmail search query).
 *
 * Shell contract (shared with VaultPanel / RemindersPanel / PagePanel / WatchPanel):
 * a `flex h-full min-h-0 flex-1 flex-col` root, a compact header row with a title
 * badge + status badge + ghost ✕ close, and exactly ONE
 * `flex-1 min-h-0 overflow-y-auto` scroll region — so it drops straight into the
 * ~400px side panel below App.tsx's tab bar.
 *
 * It talks to the rest of the extension only through existing helpers:
 *   - `src/google`        → redirect URI, connect / disconnect / status
 *   - `src/storage`       → `getSettings` / `saveSettings` for the watch prefs
 *   - a `diggy:google-check` runtime message → run the watcher on demand
 *
 * The coordinator wires this into `App.tsx`; this module must not import it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  SketchBadge,
  SketchButton,
  SketchCard,
  SketchInput,
  SketchToggle,
  ThinkingDots,
} from '@diggy/ui';
import {
  connectGoogle,
  disconnectGoogle,
  googleRedirectUrl,
  googleStatus,
  type GoogleStatus,
} from '../../src/google';
import { getSettings, saveSettings, type Settings } from '../../src/storage';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** Shape returned by the background's `diggy:google-check` handler. */
interface GoogleCheckResult {
  emails: number;
  events: number;
  alerts: string[];
}

const EMPTY_STATUS: GoogleStatus = { connected: false };

const EMPTY_RESULT: GoogleCheckResult = { emails: 0, events: 0, alerts: [] };

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function AppsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<GoogleStatus>(EMPTY_STATUS);

  const [redirectUrl, setRedirectUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<GoogleCheckResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [icsUrl, setIcsUrl] = useState('');
  const [simpleBusy, setSimpleBusy] = useState(false);
  const [simpleMsg, setSimpleMsg] = useState<string | null>(null);

  /* --- initial load ------------------------------------------------- */

  useEffect(() => {
    let alive = true;

    try {
      setRedirectUrl(googleRedirectUrl());
    } catch {
      setRedirectUrl('');
    }

    void (async () => {
      const [loadedSettings, google] = await Promise.all([
        getSettings().catch(() => null),
        googleStatus().catch(() => EMPTY_STATUS),
      ]);
      if (!alive) return;
      if (loadedSettings) setSettings(loadedSettings);
      setStatus(google);
    })();

    return () => {
      alive = false;
    };
  }, []);

  /* --- setting updates ---------------------------------------------- */

  const updateSettings = useCallback((patch: Partial<Settings>): void => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    void saveSettings(patch).catch(() => undefined);
  }, []);

  /* --- connect / disconnect ----------------------------------------- */

  const handleConnect = useCallback(async (): Promise<void> => {
    if (!settings) return;
    setConnectError(null);
    setConnecting(true);
    try {
      const next = await connectGoogle(settings.googleClientId);
      setStatus(next);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  }, [settings]);

  const handleDisconnect = useCallback(async (): Promise<void> => {
    setConnectError(null);
    setDisconnecting(true);
    try {
      await disconnectGoogle();
      setStatus(EMPTY_STATUS);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setDisconnecting(false);
    }
  }, []);

  /* --- copy redirect URI -------------------------------------------- */

  const copyRedirect = useCallback(async (): Promise<void> => {
    if (!redirectUrl) return;
    try {
      await navigator.clipboard.writeText(redirectUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setConnectError('Couldn’t reach the clipboard — select the field and copy it manually.');
    }
  }, [redirectUrl]);

  /* --- check now ---------------------------------------------------- */

  const checkNow = useCallback(async (): Promise<void> => {
    setChecking(true);
    setCheckError(null);
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'diggy:google-check',
      })) as GoogleCheckResult | undefined;
      setCheckResult(response ?? EMPTY_RESULT);
      setCheckedAt(Date.now());
    } catch (error) {
      setCheckResult(null);
      setCheckError(error instanceof Error ? error.message : 'The Diggy background did not answer.');
    } finally {
      setChecking(false);
    }
  }, []);

  /* --- zero-setup connect ------------------------------------------- */

  /** One-click, zero-setup Gmail: read the browser's existing Gmail session. */
  const enableGmailSession = useCallback(async (): Promise<void> => {
    setSimpleBusy(true);
    setSimpleMsg(null);
    try {
      updateSettings({ gmailSession: true, gmailWatch: true });
      const result = (await browser.runtime.sendMessage({ type: 'diggy:google-check' })) as
        | (GoogleCheckResult & { ok?: boolean })
        | undefined;
      setSimpleMsg(
        result?.ok
          ? `Gmail linked — ${result.emails ?? 0} recent message(s) found.`
          : 'Could not read Gmail — make sure you are signed in at mail.google.com, then retry.',
      );
    } catch (error) {
      setSimpleMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setSimpleBusy(false);
    }
  }, [updateSettings]);

  /** Zero-setup Calendar: validate + save the ICS ("secret address") URL. */
  const saveIcs = useCallback(async (): Promise<void> => {
    const url = icsUrl.trim();
    setSimpleBusy(true);
    setSimpleMsg(null);
    try {
      updateSettings({ calendarIcsUrl: url, calendarWatch: Boolean(url) });
      const result = (await browser.runtime.sendMessage({ type: 'diggy:google-check' })) as
        | (GoogleCheckResult & { ok?: boolean })
        | undefined;
      setSimpleMsg(
        url
          ? `Calendar linked — ${result?.events ?? 0} upcoming event(s) found.`
          : 'Calendar URL cleared.',
      );
    } catch (error) {
      setSimpleMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setSimpleBusy(false);
    }
  }, [icsUrl, updateSettings]);

  useEffect(() => {
    if (settings && !icsUrl) setIcsUrl(settings.calendarIcsUrl ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  /* --- render ------------------------------------------------------- */

  const connected = status.connected;
  const statusLabel = connected
    ? status.email
      ? `Google linked · ${status.email}`
      : 'Google linked'
    : 'not linked';

  return (
    <div className="diggy-root diggy-panel diggy-panel-enter flex h-full min-h-0 flex-1 flex-col bg-paper text-sm text-ink">
      <header className="diggy-panel-header flex shrink-0 items-center justify-between gap-2 border-b-2 border-ink/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SketchBadge accent="sky" size="md" dot className="diggy-panel-title">
            Apps
          </SketchBadge>
          <SketchBadge
            accent={connected ? 'green' : 'amber'}
            size="sm"
            className="max-w-[70%] overflow-hidden text-ellipsis whitespace-nowrap"
            title={statusLabel}
          >
            {statusLabel}
          </SketchBadge>
        </div>
        <SketchButton
          size="sm"
          variant="ghost"
          aria-label="Close apps"
          title="Close"
          className="w-8 shrink-0 px-0"
          onClick={onClose}
        >
          ✕
        </SketchButton>
      </header>

      <div className="diggy-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-3 py-3">
        {!settings ? (
          <div className="flex items-center justify-center gap-2 py-6 text-ink-500">
            <ThinkingDots size="sm" />
            <span>Loading apps…</span>
          </div>
        ) : (
          <>
            {/* Google (Gmail + Calendar) -------------------------------- */}
            <SketchCard tone="accent" accent="green" className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="diggy-panel-title text-ink-700">SIMPLE CONNECT · NO SETUP</span>
                <SketchBadge accent="green" size="sm">
                  easiest
                </SketchBadge>
              </div>
              <p className="text-xs leading-snug text-ink-700">
                You are already signed in to Google in this browser, so Diggy can read your inbox and
                calendar through that session — no Cloud Console, no client ID, no redirect URL.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <SketchButton
                  size="sm"
                  variant="accent"
                  accent="green"
                  loading={simpleBusy}
                  onClick={() => void enableGmailSession()}
                >
                  Connect Gmail (no setup)
                </SketchButton>
                <SketchToggle
                  label="Watch Gmail"
                  checked={Boolean(settings?.gmailSession)}
                  onCheckedChange={(checked) => updateSettings({ gmailSession: checked })}
                />
              </div>
              <SketchInput
                label="Calendar ICS URL (Calendar → Settings → “Secret address in iCal format”)"
                placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                value={icsUrl}
                onChange={(event) => setIcsUrl(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <SketchButton size="sm" variant="paper" loading={simpleBusy} onClick={() => void saveIcs()}>
                  Save calendar URL
                </SketchButton>
                <span className="text-[11px] text-ink-500">
                  {settings?.calendarIcsUrl ? 'calendar linked ✓' : 'not linked'}
                </span>
              </div>
              {simpleMsg ? <p className="break-words text-[11px] text-ink-700">{simpleMsg}</p> : null}
            </SketchCard>

            <SketchCard tone="accent" accent="sky" className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="diggy-panel-title text-xs font-semibold text-ink-500">
                  Google · Gmail + Calendar
                </span>
                <SketchBadge accent={connected ? 'green' : 'amber'} size="sm" dot>
                  {connected ? 'connected' : 'setup'}
                </SketchBadge>
              </div>

              {!connected ? (
                <>
                  <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-snug text-ink-500">
                    <li>
                      In the Google Cloud Console, create an OAuth client of type{' '}
                      <span className="font-semibold text-ink-700">Web application</span>.
                    </li>
                    <li>
                      Add the redirect URI shown below to that client’s{' '}
                      <span className="font-semibold text-ink-700">Authorised redirect URIs</span>.
                    </li>
                    <li>Paste the generated Client ID here.</li>
                    <li>
                      Hit <span className="font-semibold text-ink-700">Connect Google</span> and approve
                      Gmail + Calendar access.
                    </li>
                  </ol>

                  <div className="flex items-end gap-2">
                    <SketchInput
                      label="Redirect URI"
                      readOnly
                      value={redirectUrl || 'Unavailable — open this panel in the extension.'}
                      containerClassName="min-w-0 flex-1"
                      className="font-mono text-[11px]"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <SketchButton
                      size="sm"
                      variant="paper"
                      accent="sky"
                      disabled={!redirectUrl}
                      className="mb-0.5 shrink-0 whitespace-nowrap"
                      onClick={() => void copyRedirect()}
                    >
                      {copied ? 'Copied ✓' : 'Copy'}
                    </SketchButton>
                  </div>

                  <SketchInput
                    label="Client ID"
                    placeholder="1234567890-abc.apps.googleusercontent.com"
                    value={settings.googleClientId}
                    onChange={(event) => updateSettings({ googleClientId: event.target.value })}
                    hint="Stored locally — it stays in this browser."
                  />

                  {connectError ? (
                    <p
                      role="alert"
                      className="break-words rounded-sketch-sm bg-crayon-red-soft/60 px-2 py-1 text-[12px] leading-snug text-crayon-red-deep"
                    >
                      {connectError}
                    </p>
                  ) : null}

                  <div className="flex items-center justify-end">
                    <SketchButton
                      size="sm"
                      variant="accent"
                      accent="sky"
                      loading={connecting}
                      disabled={!settings.googleClientId.trim()}
                      className="shrink-0 whitespace-nowrap"
                      onClick={() => void handleConnect()}
                    >
                      Connect Google
                    </SketchButton>
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink-700" title={status.email ?? undefined}>
                        {status.email ?? 'Google account'}
                      </p>
                      <p className="text-[11px] leading-snug text-ink-500">
                        Read-only access to Gmail + Calendar.
                      </p>
                    </div>
                    <SketchButton
                      size="sm"
                      variant="ghost"
                      accent="red"
                      loading={disconnecting}
                      className="shrink-0 whitespace-nowrap"
                      onClick={() => void handleDisconnect()}
                    >
                      Disconnect
                    </SketchButton>
                  </div>

                  {connectError ? (
                    <p
                      role="alert"
                      className="break-words rounded-sketch-sm bg-crayon-red-soft/60 px-2 py-1 text-[12px] leading-snug text-crayon-red-deep"
                    >
                      {connectError}
                    </p>
                  ) : null}
                </div>
              )}
            </SketchCard>

            {/* Watching ------------------------------------------------- */}
            <SketchCard tone="paper" className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="diggy-panel-title text-xs font-semibold text-ink-500">Watching</span>
                {!connected ? (
                  <SketchBadge accent="amber" size="sm">
                    connect first
                  </SketchBadge>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <SketchToggle
                  label="Watch Gmail"
                  accent="red"
                  size="sm"
                  checked={settings.gmailWatch}
                  onCheckedChange={(value) => updateSettings({ gmailWatch: value })}
                />
                <SketchToggle
                  label="Watch Calendar"
                  accent="green"
                  size="sm"
                  checked={settings.calendarWatch}
                  onCheckedChange={(value) => updateSettings({ calendarWatch: value })}
                />
              </div>

              <SketchInput
                label="Gmail search query"
                accent="teal"
                placeholder="in:inbox is:unread newer_than:1d"
                value={settings.gmailQuery}
                onChange={(event) => updateSettings({ gmailQuery: event.target.value })}
                hint="Only mail matching this query is scanned."
              />

              <div className="flex items-center justify-between gap-2">
                <SketchButton
                  size="sm"
                  variant="accent"
                  accent="sky"
                  loading={checking}
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void checkNow()}
                >
                  Check now
                </SketchButton>
                {checkedAt ? (
                  <span className="text-[11px] text-ink-500">
                    checked {new Date(checkedAt).toLocaleTimeString()}
                  </span>
                ) : null}
              </div>

              {checkError ? (
                <p
                  role="alert"
                  className="break-words rounded-sketch-sm bg-crayon-red-soft/60 px-2 py-1 text-[12px] leading-snug text-crayon-red-deep"
                >
                  {checkError}
                </p>
              ) : null}

              {checkResult ? (
                <div className="space-y-1.5 rounded-sketch-sm bg-paper-100 p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SketchBadge accent="sky" size="sm">
                      {checkResult.emails} mail
                    </SketchBadge>
                    <SketchBadge accent="violet" size="sm">
                      {checkResult.events} events
                    </SketchBadge>
                    <SketchBadge accent="amber" size="sm">
                      {checkResult.alerts.length} alert{checkResult.alerts.length === 1 ? '' : 's'}
                    </SketchBadge>
                  </div>
                  {checkResult.alerts.length > 0 ? (
                    <ul className="space-y-0.5 text-[11px] leading-snug text-ink-700">
                      {checkResult.alerts.map((alert, index) => (
                        <li key={`${index}-${alert}`} className="break-words">
                          {alert}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] leading-snug text-ink-500">
                      Nothing new to report right now.
                    </p>
                  )}
                </div>
              ) : null}
            </SketchCard>

            {/* How it works -------------------------------------------- */}
            <SketchCard tone="muted" className="space-y-1">
              <span className="diggy-panel-title text-xs font-semibold text-ink-500">How it works</span>
              <p className="text-[11px] leading-snug text-ink-500">
                Diggy checks Gmail + Calendar automatically every few minutes in the background.
                Important mail — offers, interviews, selections, deadlines — is announced excitedly in
                the page and as a notification, and calendar events starting within ~20 minutes get a
                reminder ping.
              </p>
            </SketchCard>
          </>
        )}
      </div>
    </div>
  );
}
