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
  /** Show the floating in-page avatar bubble by default. */
  avatarVisible: boolean;
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
 * Build-time env defaults (from a gitignored `apps/extension/.env`).
 * These make the bot work out of the box for local/dev builds; they are baked
 * into the bundle, so never ship a build made with keys present.
 */
const ENV = import.meta.env as unknown as Record<string, string | undefined>;

export const DEFAULT_SETTINGS: Settings = {
  provider: ENV.VITE_DEFAULT_PROVIDER === 'nvidia' ? 'nvidia' : 'groq',
  groqKey: ENV.VITE_GROQ_API_KEY ?? '',
  nvidiaKey: ENV.VITE_NVIDIA_API_KEY ?? '',
  model: '',
  bridgeUrl: BRIDGE_DEFAULT_URL,
  bridgeToken: '',
  crawlerUrl: CRAWLER_DEFAULT_URL,
  apiUrl: API_DEFAULT_URL,
  voiceEnabled: true,
  avatarVisible: true,
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
  // An empty key means "never set", not "deliberately off": fall back to the
  // build's default so provider failover keeps working instead of silently
  // leaving the user with a single brain.
  if (!stored.groqKey) delete stored.groqKey;
  if (!stored.nvidiaKey) delete stored.nvidiaKey;
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
