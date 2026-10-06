/**
 * PluginsPanel — the Diggy "one-click plugins" gallery for the side panel.
 *
 * Signed out: a short explainer + a **Sign in with Google** button (pairing
 * flow owned by `src/api-client`), plus a "Backend: <url>" hint that reflects
 * whether `GET /health` answered.
 *
 * Signed in: one row per plugin — icon, name, description, `accountLabel`, and
 * a right-aligned Connect / Connected ✓ + Disconnect control. Rows show a
 * spinner while connecting and report per-row errors.
 *
 * Shell contract (shared with VaultPanel / RemindersPanel / AppsPanel): a
 * `flex h-full min-h-0 flex-1 flex-col` root, a compact header row with a title
 * badge + status badge + ghost ✕ close, and exactly ONE
 * `flex-1 min-h-0 overflow-y-auto` scroll region.
 *
 * The coordinator wires this into `App.tsx`; this module must not import it.
 */
import { useCallback, useEffect, useState } from 'react';
import { SketchBadge, SketchButton, SketchCard, ThinkingDots } from '@diggy/ui';
import {
  apiBase,
  apiHealth,
  clearSession,
  connectPlugin,
  disconnectPlugin,
  getSession,
  listPlugins,
  signInWithGoogle,
  type ApiHealth,
  type ApiPlugin,
  type ApiSession,
} from '../../src/api-client';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * Backend hint
 * ------------------------------------------------------------------ */

function BackendHint({
  baseUrl,
  health,
  checking,
  onRetry,
}: {
  baseUrl: string;
  health: ApiHealth | null;
  checking: boolean;
  onRetry: () => void;
}): JSX.Element {
  const ok = health !== null;
  return (
    <SketchCard tone="muted" padded={false} className="p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate font-sketch text-[11px] text-ink-500" title={baseUrl}>
            Backend: {baseUrl}
          </p>
          <SketchBadge accent={ok ? 'green' : 'red'} size="sm" dot className="self-start">
            {ok ? 'online ✓' : 'not responding'}
          </SketchBadge>
        </div>
        <SketchButton
          size="sm"
          variant="ghost"
          accent={ok ? 'sky' : 'amber'}
          loading={checking}
          className="shrink-0 whitespace-nowrap"
          onClick={onRetry}
        >
          Retry
        </SketchButton>
      </div>
    </SketchCard>
  );
}

/* ------------------------------------------------------------------ *
 * Plugin row
 * ------------------------------------------------------------------ */

function PluginRow({
  plugin,
  connecting,
  disconnecting,
  error,
  onConnect,
  onDisconnect,
}: {
  plugin: ApiPlugin;
  connecting: boolean;
  disconnecting: boolean;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}): JSX.Element {
  const [iconBroken, setIconBroken] = useState(false);

  return (
    <SketchCard tone="paper" accent={plugin.connected ? 'green' : 'sky'} padded={false} className="space-y-2 p-2.5">
      <div className="flex items-start gap-2">
        {plugin.icon && !iconBroken ? (
          <img
            src={plugin.icon}
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 shrink-0 rounded-sm object-contain"
            onError={() => setIconBroken(true)}
          />
        ) : (
          <span
            aria-hidden="true"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-sm bg-paper-200 text-xs"
          >
            🔌
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-sketch text-sm font-semibold text-ink" title={plugin.name}>
              {plugin.name}
            </span>
            {plugin.auth === 'oauth2' ? (
              <SketchBadge accent="violet" size="sm">
                oauth
              </SketchBadge>
            ) : null}
          </div>
          {plugin.description ? (
            <p className="truncate font-sketch text-[11px] leading-snug text-ink-500" title={plugin.description}>
              {plugin.description}
            </p>
          ) : null}
          {plugin.accountLabel ? (
            <p className="truncate font-sketch text-[11px] leading-snug text-ink-400" title={plugin.accountLabel}>
              {plugin.accountLabel}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {plugin.connected ? (
            <>
              <SketchBadge accent="green" size="sm" dot>
                Connected ✓
              </SketchBadge>
              <SketchButton
                size="sm"
                variant="ghost"
                accent="red"
                loading={disconnecting}
                aria-label={`Disconnect ${plugin.name}`}
                className="whitespace-nowrap"
                onClick={onDisconnect}
              >
                Disconnect
              </SketchButton>
            </>
          ) : (
            <SketchButton
              size="sm"
              variant="accent"
              accent="sky"
              loading={connecting}
              aria-label={`Connect ${plugin.name}`}
              className="whitespace-nowrap"
              onClick={onConnect}
            >
              Connect
            </SketchButton>
          )}
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="break-words rounded-sketch-sm bg-crayon-red-soft/60 px-2 py-1 font-sketch text-[11px] leading-snug text-crayon-red-deep"
        >
          {error}
        </p>
      ) : null}
    </SketchCard>
  );
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function PluginsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [ready, setReady] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const [session, setSession] = useState<ApiSession | null>(null);
  const [plugins, setPlugins] = useState<ApiPlugin[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);

  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  /* --- data --------------------------------------------------------- */

  const checkHealth = useCallback(async (): Promise<ApiHealth | null> => {
    setCheckingHealth(true);
    try {
      const next = await apiHealth();
      setHealth(next);
      return next;
    } finally {
      setCheckingHealth(false);
    }
  }, []);

  const refreshPlugins = useCallback(
    async (active?: ApiSession | null): Promise<void> => {
      const current = active ?? session;
      if (!current) {
        setPlugins([]);
        return;
      }
      setLoadingPlugins(true);
      setPluginsError(null);
      try {
        setPlugins(await listPlugins());
      } catch (error) {
        setPluginsError(message(error));
      } finally {
        setLoadingPlugins(false);
      }
    },
    [session],
  );

  // Mount: restore the session, probe /health, then load plugins.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [stored, base] = await Promise.all([getSession(), apiBase()]);
      if (!alive) return;
      setSession(stored);
      setBaseUrl(base);

      const status = await apiHealth();
      if (!alive) return;
      setHealth(status);

      if (stored) await refreshPlugins(stored);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [refreshPlugins]);

  /* --- actions ------------------------------------------------------ */

  const handleSignIn = useCallback(async (): Promise<void> => {
    setSigningIn(true);
    setSignInError(null);
    try {
      await signInWithGoogle();
      const next = await getSession();
      setSession(next);
      setBaseUrl(next?.apiUrl ?? (await apiBase()));
      setHealth(await apiHealth());
      await refreshPlugins(next);
    } catch (error) {
      setSignInError(message(error));
    } finally {
      setSigningIn(false);
    }
  }, [refreshPlugins]);

  const handleSignOut = useCallback(async (): Promise<void> => {
    await clearSession();
    setSession(null);
    setPlugins([]);
    setPluginsError(null);
    setRowErrors({});
  }, []);

  const handleConnect = useCallback(
    async (provider: string): Promise<void> => {
      setConnectingId(provider);
      setRowErrors((current) => ({ ...current, [provider]: '' }));
      try {
        await connectPlugin(provider);
        await refreshPlugins();
      } catch (error) {
        setRowErrors((current) => ({ ...current, [provider]: message(error) }));
      } finally {
        setConnectingId(null);
      }
    },
    [refreshPlugins],
  );

  const handleDisconnect = useCallback(
    async (provider: string): Promise<void> => {
      setDisconnectingId(provider);
      setRowErrors((current) => ({ ...current, [provider]: '' }));
      try {
        await disconnectPlugin(provider);
        await refreshPlugins();
      } catch (error) {
        setRowErrors((current) => ({ ...current, [provider]: message(error) }));
      } finally {
        setDisconnectingId(null);
      }
    },
    [refreshPlugins],
  );

  /* --- derived ------------------------------------------------------ */

  const signedIn = session !== null;
  const statusLabel = session
    ? session.user.email
      ? `signed in · ${session.user.email}`
      : 'signed in'
    : 'offline';

  const connectedCount = plugins.filter((plugin) => plugin.connected).length;

  /* --- render ------------------------------------------------------- */

  return (
    <div className="diggy-root diggy-panel diggy-panel-enter flex h-full min-h-0 flex-1 flex-col bg-paper text-sm text-ink">
      <header className="diggy-panel-header flex shrink-0 items-center justify-between gap-2 border-b-2 border-ink/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SketchBadge accent="violet" size="md" dot className="diggy-panel-title">
            Plugins
          </SketchBadge>
          <SketchBadge
            accent={signedIn ? 'green' : 'amber'}
            size="sm"
            className="max-w-[60%] overflow-hidden text-ellipsis whitespace-nowrap"
            title={statusLabel}
          >
            {statusLabel}
          </SketchBadge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {signedIn ? (
            <SketchButton size="sm" variant="ghost" onClick={() => void handleSignOut()}>
              Sign out
            </SketchButton>
          ) : null}
          <SketchButton
            size="sm"
            variant="ghost"
            aria-label="Close plugins"
            title="Close"
            className="w-8 shrink-0 px-0"
            onClick={onClose}
          >
            ✕
          </SketchButton>
        </div>
      </header>

      <div className="diggy-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-3 py-3">
        {!ready ? (
          <div className="flex items-center justify-center gap-2 py-6 text-ink-500">
            <ThinkingDots size="sm" />
            <span>Loading plugins…</span>
          </div>
        ) : !signedIn ? (
          <>
            {/* Signed out ------------------------------------------------ */}
            <SketchCard tone="accent" accent="violet" className="space-y-2.5">
              <p className="font-sketch text-sm font-semibold text-ink-700">One-click plugins</p>
              <p className="text-xs leading-snug text-ink-700">Sign in once — no URLs, no keys.</p>
              <SketchButton
                size="sm"
                variant="accent"
                accent="sky"
                loading={signingIn}
                className="whitespace-nowrap"
                onClick={() => void handleSignIn()}
              >
                Sign in with Google
              </SketchButton>
              {signingIn ? (
                <p className="text-[11px] leading-snug text-ink-500">
                  Finish signing in with Google in the new tab — this panel is listening.
                </p>
              ) : null}
              {signInError ? (
                <p
                  role="alert"
                  className="break-words rounded-sketch-sm bg-crayon-red-soft/60 px-2 py-1 font-sketch text-[12px] leading-snug text-crayon-red-deep"
                >
                  {signInError}
                </p>
              ) : null}
            </SketchCard>

            <BackendHint
              baseUrl={baseUrl}
              health={health}
              checking={checkingHealth}
              onRetry={() => void checkHealth()}
            />

            {health === null ? (
              <SketchCard tone="accent" accent="red" className="space-y-1">
                <p className="font-sketch text-xs font-semibold text-crayon-red-deep">
                  Backend not running
                </p>
                <p className="font-sketch text-[11px] leading-snug text-ink-700">
                  Start it with{' '}
                  <span className="font-mono">pnpm --filter @diggy/api start</span>, then hit Retry.
                </p>
              </SketchCard>
            ) : null}
          </>
        ) : (
          <>
            {/* Signed in ------------------------------------------------ */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <SketchBadge accent="sky" size="sm">
                  {plugins.length} plugin{plugins.length === 1 ? '' : 's'}
                </SketchBadge>
                {connectedCount > 0 ? (
                  <SketchBadge accent="green" size="sm">
                    {connectedCount} connected
                  </SketchBadge>
                ) : null}
              </div>
              <SketchButton
                size="sm"
                variant="ghost"
                loading={loadingPlugins}
                className="shrink-0 whitespace-nowrap"
                onClick={() => void refreshPlugins()}
              >
                Refresh
              </SketchButton>
            </div>

            {health === null ? (
              <SketchCard tone="accent" accent="red" className="space-y-2">
                <p className="font-sketch text-xs font-semibold text-crayon-red-deep">
                  Backend not running
                </p>
                <p className="font-sketch text-[11px] leading-snug text-ink-700">
                  Start it with{' '}
                  <span className="font-mono">pnpm --filter @diggy/api start</span>, then refresh.
                </p>
                <SketchButton size="sm" variant="accent" accent="red" onClick={() => void checkHealth()}>
                  Recheck
                </SketchButton>
              </SketchCard>
            ) : null}

            {pluginsError ? (
              <p
                role="alert"
                className="break-words rounded-sketch-sm bg-crayon-red-soft/60 px-2 py-1 font-sketch text-[12px] leading-snug text-crayon-red-deep"
              >
                {pluginsError}
              </p>
            ) : null}

            {loadingPlugins && plugins.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-ink-500">
                <ThinkingDots size="sm" />
                <span>Loading plugins…</span>
              </div>
            ) : null}

            {!loadingPlugins && !pluginsError && plugins.length === 0 ? (
              <SketchCard tone="muted" className="space-y-1 text-center">
                <p className="font-sketch text-sm text-ink-700">No plugins available yet. 🧩</p>
                <p className="font-sketch text-[11px] leading-snug text-ink-500">
                  Plugins you can connect will appear here.
                </p>
              </SketchCard>
            ) : null}

            {plugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                connecting={connectingId === plugin.id}
                disconnecting={disconnectingId === plugin.id}
                error={rowErrors[plugin.id] ? rowErrors[plugin.id] : null}
                onConnect={() => void handleConnect(plugin.id)}
                onDisconnect={() => void handleDisconnect(plugin.id)}
              />
            ))}

            <BackendHint
              baseUrl={baseUrl}
              health={health}
              checking={checkingHealth}
              onRetry={() => void checkHealth()}
            />
          </>
        )}
      </div>
    </div>
  );
}
