/**
 * Typed `chrome.storage.local` access for settings, the (locally cached)
 * profile, reminders and todos.
 *
 * The desktop companion remains the source of truth for the vault, but the
 * extension keeps its own copy so it degrades gracefully when the desktop app
 * is not running.
 */
import {
  API_DEFAULT_URL,
  BRIDGE_DEFAULT_URL,
  BRIDGE_PROTOCOL_VERSION,
  CRAWLER_DEFAULT_URL,
  type Profile,
  type Reminder,
} from '@diggy/shared';

export interface Settings {
  /** Which LLM provider the local brain should use. */
  provider: 'groq' | 'nvidia';
  /** Groq API key (empty = not configured). */
  groqKey: string;
  /** NVIDIA NIM API key (empty = not configured). */
  nvidiaKey: string;
  /** Optional model override. */
  model: string;
  /** Desktop companion WebSocket URL. */
  bridgeUrl: string;
  /** Shared bridge auth token. */
  bridgeToken: string;
  /** Crawler service base URL. */
  crawlerUrl: string;
  /** One-click plugins backend base URL. */
  apiUrl: string;
  /** Speak assistant replies aloud when possible. */
  voiceEnabled: boolean;
  /**
   * Push-to-talk behaviour. `hold` (the default) records while the shortcut is
   * held and sends on release; `toggle` starts on one press and sends on the
   * next — or by itself once the offscreen recorder hears silence. A
   * `chrome.commands` shortcut has no key-up, so it can only ever toggle.
   */
  voiceMode: 'hold' | 'toggle';
  /** Show the floating in-page avatar bubble by default. */
  avatarVisible: boolean;
  /**
   * Fetch the VRM model eagerly when the bubble is created, instead of the
   * first time the avatar is actually shown. Default `false`: the bubble is
   * created hidden and the 17 MB model is only fetched once the avatar is
   * revealed (the user's first interaction, or the first assistant reply).
   */
  avatarAutoLoad?: boolean;
  /**
   * Extra hostnames that must never show the in-page avatar, on top of the
   * built-in sensitive-site list (see {@link DEFAULT_AVATAR_DISABLED_SITES}).
   * Plain hostnames or `*.` suffixes, e.g. `my-bank.example`, `*.corp.internal`.
   *
   * A list we cannot parse fails **closed**: see {@link isAvatarDisabledForHost}.
   */
  avatarDisabledSites?: string[];
  /**
   * Per-site allow list for the agent **policy layer**.
   *
   * The policy package blocks sensitive sites (banks, payment pages, password
   * managers, health portals) for reading *and* acting. A host listed here is an
   * explicit user override for those rules, e.g. `chase.com`, `my-bank.example`
   * or a full URL. Empty by default: with no entries, every sensitive site stays
   * blocked (the safe default). Entries that are not strings are ignored.
   */
  sensitiveSiteAllowlist?: string[];
  /** Push-to-talk shortcut (hold to talk), e.g. "Ctrl+Shift+Space". */
  shortcut: string;
  /** Google OAuth client id (Web application) for Gmail + Calendar. */
  googleClientId: string;
  /** Zero-setup: use the browser's Gmail session instead of OAuth. */
  gmailSession: boolean;
  /** Which signed-in Google account the session feed reads (0 = default). */
  gmailAccount: number;
  /** Zero-setup: calendar "Secret address in iCal format" URL. */
  calendarIcsUrl: string;
  /** Watch the Gmail inbox for important mail. */
  gmailWatch: boolean;
  /** Watch the calendar for events that are about to start. */
  calendarWatch: boolean;
  /** Gmail search query used by the watcher. */
  gmailQuery: string;
}

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

/**
 * Build-time defaults from a gitignored `apps/extension/.env`.
 *
 * Only NON-SECRET values may be baked in here. API keys are deliberately NOT
 * read from the environment: a bundle with keys inside leaks them to anyone who
 * opens the build. Keys come from Settings at runtime (`getSettings`), and
 * `.env.example` documents every value this file may pick up.
 */
const ENV =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const DEFAULT_SETTINGS: Settings = {
  provider: ENV.VITE_DEFAULT_PROVIDER === 'nvidia' ? 'nvidia' : 'groq',
  // Keys are user-supplied — never baked into a build.
  groqKey: '',
  nvidiaKey: '',
  model: '',
  bridgeUrl: BRIDGE_DEFAULT_URL,
  bridgeToken: '',
  crawlerUrl: CRAWLER_DEFAULT_URL,
  apiUrl: API_DEFAULT_URL,
  voiceEnabled: true,
  // Hold-to-talk by default: today's behaviour is unchanged unless the user
  // flips the Settings toggle to press-to-talk (toggle) mode.
  voiceMode: 'hold',
  avatarVisible: true,
  // Lazy by default: the bubble is created hidden and the model is fetched the
  // first time the avatar is shown (see `avatarAutoLoad` above).
  avatarAutoLoad: false,
  avatarDisabledSites: [],
  // The policy layer blocks sensitive sites by default; this list is the only
  // way to allow one. Empty = nothing allow-listed (the safe default).
  sensitiveSiteAllowlist: [],
  shortcut: 'Ctrl+Space',
  googleClientId: ENV.VITE_GOOGLE_CLIENT_ID ?? '',
  gmailSession: false,
  gmailAccount: 0,
  calendarIcsUrl: '',
  gmailWatch: false,
  calendarWatch: false,
  gmailQuery: 'in:inbox is:unread newer_than:1d',
};

/** The API key for the currently selected provider. */
export function activeApiKey(settings: Settings): string {
  const key = settings.provider === 'nvidia' ? settings.nvidiaKey : settings.groqKey;
  return (key ?? '').trim();
}

/* ------------------------------------------------------------------ *
 * Per-site avatar disable list
 * ------------------------------------------------------------------ */

/**
 * Hosts where the in-page avatar must **never** mount.
 *
 * The security brief's "do not draw a bot on top of this" sites fall into four
 * families — banking, payments, password managers and health portals — because
 * an overlay on those pages is at best a phish-shaped distraction and at worst
 * a privacy leak (the bot's reader/form-filler running beside a login, a
 * stranger's face over a balance). This is the shipped default; users can add
 * their own entries via {@link Settings.avatarDisabledSites}, but the built-in
 * entries are always applied.
 *
 * Matching is a plain case-insensitive hostname *suffix* match — never a regex
 * — so a hostile or malformed entry can neither widen the match nor hang the
 * matcher.
 */
export const DEFAULT_AVATAR_DISABLED_SITES: readonly string[] = [
  // --- Banking -------------------------------------------------------
  'hdfcbank.com',
  'icicibank.com',
  'sbi.co.in',
  'onlinesbi.sbi',
  'axisbank.com',
  'kotak.com',
  'yesbank.in',
  'indusind.com',
  'bankofindia.co.in',
  'rbi.org.in',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citibank.com',
  'capitalone.com',
  'hsbc.com',
  'barclays.co.uk',
  'lloydsbank.com',
  'natwest.com',
  'monzo.com',
  'revolut.com',
  'deutsche-bank.de',
  'bnpparibas.com',
  // --- Payments / checkout ------------------------------------------
  'paypal.com',
  'stripe.com',
  'razorpay.com',
  'paytm.com',
  'phonepe.com',
  'wise.com',
  'squareup.com',
  'checkout.com',
  'adyen.com',
  'klarna.com',
  'coinbase.com',
  'binance.com',
  // --- Password managers / identity ---------------------------------
  '1password.com',
  'lastpass.com',
  'bitwarden.com',
  'dashlane.com',
  'keeper.com',
  'nordpass.com',
  'keepersecurity.com',
  'okta.com',
  'authy.com',
  'duo.com',
  // --- Health portals ------------------------------------------------
  'nhs.uk',
  'kaiserpermanente.org',
  'mychart.org',
  'mayoclinic.org',
  'practo.com',
  'apollopharmacy.in',
  'netmeds.com',
  'pharmeasy.in',
  'cvs.com',
  'walgreens.com',
  // --- Government / tax ---------------------------------------------
  'incometax.gov.in',
  'uidai.gov.in',
  'irs.gov',
];

/**
 * Turn one user entry into a comparable hostname, or `null` when it is junk.
 *
 * Accepts a bare host, a `*.host` wildcard, or a pasted URL. Anything that
 * still contains characters a hostname cannot (after stripping a scheme, a
 * path, a port and leading/trailing dots) is rejected so the caller can fail
 * closed.
 */
function normaliseHostPattern(entry: string): string | null {
  let value = entry.trim().toLowerCase();
  if (value === '') return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme://
  value = value.split('/')[0] ?? ''; // strip path
  value = value.split(':')[0] ?? ''; // strip :port
  value = value.replace(/^\*\./, ''); // strip a leading *. wildcard
  value = value.replace(/^\.+|\.+$/g, ''); // trim stray dots
  if (value === '' || /[^a-z0-9.-]/.test(value)) return null;
  return value;
}

/**
 * True when the avatar must not mount on `hostname`.
 *
 * **Fails closed.** If the host is missing, or the stored list exists but is
 * not an array, or *any* entry cannot be parsed into a hostname, we refuse to
 * mount rather than guess — the safe default is "no bot on this page". The
 * built-in {@link DEFAULT_AVATAR_DISABLED_SITES} list is always applied on top
 * of whatever the user added.
 */
export function isAvatarDisabledForHost(
  hostname: unknown,
  settings: Settings | null | undefined,
): boolean {
  if (typeof hostname !== 'string' || hostname.trim() === '') return true;
  const host = hostname.trim().toLowerCase();
  if (/[^a-z0-9.-]/.test(host)) return true; // not a plain host → distrust it

  const raw = settings?.avatarDisabledSites;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) return true; // corrupt list → fail closed

  const patterns: string[] = [...DEFAULT_AVATAR_DISABLED_SITES];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') return true; // malformed entry → fail closed
      const pattern = normaliseHostPattern(entry);
      if (pattern === null) return true; // unparseable entry → fail closed
      patterns.push(pattern);
    }
  }

  return patterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
}

export const BRIDGE_PROTOCOL = BRIDGE_PROTOCOL_VERSION;

export const STORAGE_KEYS = {
  settings: 'diggy:settings',
  profile: 'diggy:profile',
  reminders: 'diggy:reminders',
  todos: 'diggy:todos',
} as const;

async function readValue<T>(key: string, fallback: T): Promise<T> {
  try {
    const store = (await browser.storage.local.get(key)) as Record<string, unknown>;
    const value = store[key];
    return (value as T | undefined) ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeValue<T>(key: string, value: T): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/**
 * Shortcuts we used to ship. A stored value that still equals an old default
 * means the user never picked one — so it follows the current default instead
 * of pinning them to a chord we no longer recommend.
 */
const LEGACY_SHORTCUTS = ['Ctrl+Shift+Space'];

export async function getSettings(): Promise<Settings> {
  const stored = await readValue<Partial<Settings>>(STORAGE_KEYS.settings, {});
  if (stored.shortcut && LEGACY_SHORTCUTS.includes(stored.shortcut)) delete stored.shortcut;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(await getSettings()), ...patch };
  await writeValue(STORAGE_KEYS.settings, next);
  return next;
}

export function watchSettings(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(STORAGE_KEYS.settings in changes)) return;
    void getSettings().then(callback);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/* ------------------------------------------------------------------ *
 * Profile (local cache)
 * ------------------------------------------------------------------ */

export async function getProfile(): Promise<Profile | null> {
  return readValue<Profile | null>(STORAGE_KEYS.profile, null);
}

export async function setProfile(profile: Profile | null): Promise<void> {
  await writeValue(STORAGE_KEYS.profile, profile);
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

export async function getReminders(): Promise<Reminder[]> {
  return readValue<Reminder[]>(STORAGE_KEYS.reminders, []);
}

export async function saveReminders(reminders: Reminder[]): Promise<void> {
  await writeValue(STORAGE_KEYS.reminders, reminders);
}

export async function addReminder(reminder: Reminder): Promise<void> {
  const list = await getReminders();
  await saveReminders([...list.filter((item) => item.id !== reminder.id), reminder]);
}

export async function updateReminder(id: string, patch: Partial<Reminder>): Promise<Reminder | null> {
  const list = await getReminders();
  let updated: Reminder | null = null;
  const next = list.map((item) => {
    if (item.id !== id) return item;
    updated = { ...item, ...patch };
    return updated;
  });
  await saveReminders(next);
  return updated;
}

/* ------------------------------------------------------------------ *
 * Todos
 * ------------------------------------------------------------------ */

export async function getTodos(): Promise<Todo[]> {
  return readValue<Todo[]>(STORAGE_KEYS.todos, []);
}

export async function saveTodos(todos: Todo[]): Promise<void> {
  await writeValue(STORAGE_KEYS.todos, todos);
}
