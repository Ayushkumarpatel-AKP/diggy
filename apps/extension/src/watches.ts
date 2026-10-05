/**
 * Watched-site storage for the "watch the web for me" feature.
 *
 * The background worker periodically fetches each watch and, when the page
 * changes or the configured keyword appears, raises a notification (and the
 * assistant celebrates it). Kept in `chrome.storage.local` so it survives
 * service-worker restarts.
 */
export interface Watch {
  id: string;
  /** Friendly name, e.g. "Naukri — frontend roles". */
  label: string;
  /** Page to poll. */
  url: string;
  /** Optional keyword/regex-free substring that should trigger a notification. */
  keyword?: string;
  enabled: boolean;
  createdAt: string;
  lastCheckedAt?: string;
  /** Hash of the last fetched text, to detect changes. */
  lastHash?: string;
}

export const MAX_WATCHES = 10;
export const WATCHES_KEY = 'diggy:watches';

async function readValue<T>(key: string, fallback: T): Promise<T> {
  try {
    const store = (await browser.storage.local.get(key)) as Record<string, unknown>;
    return ((store[key] as T | undefined) ?? fallback) as T;
  } catch {
    return fallback;
  }
}

async function writeValue<T>(key: string, value: T): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

export async function getWatches(): Promise<Watch[]> {
  return readValue<Watch[]>(WATCHES_KEY, []);
}

export async function saveWatches(watches: Watch[]): Promise<void> {
  await writeValue(WATCHES_KEY, watches.slice(0, MAX_WATCHES));
}

export function makeWatchId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `watch-${uuid}`;
}

export async function addWatch(watch: Watch): Promise<Watch[]> {
  const list = await getWatches();
  if (list.length >= MAX_WATCHES) {
    throw new Error(`You can watch at most ${MAX_WATCHES} sites.`);
  }
  const next = [...list.filter((item) => item.id !== watch.id), watch];
  await saveWatches(next);
  return next;
}

export async function updateWatch(id: string, patch: Partial<Watch>): Promise<Watch[]> {
  const list = await getWatches();
  const next = list.map((item) => (item.id === id ? { ...item, ...patch } : item));
  await saveWatches(next);
  return next;
}

export async function removeWatch(id: string): Promise<Watch[]> {
  const list = await getWatches();
  const next = list.filter((item) => item.id !== id);
  await saveWatches(next);
  return next;
}
