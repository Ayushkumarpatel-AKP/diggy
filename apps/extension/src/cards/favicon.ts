/**
 * Favicon helpers for rich cards.
 *
 * `faviconUrlFor` builds a keyless Google favicon-service URL for any page —
 * no API key, no per-site scraping. When a page's Content-Security-Policy
 * blocks the remote image inside a content script, `fetchAsDataUrl` fetches
 * the bytes in the background (extension context) and hands back a `data:`
 * URL the renderer can always show.
 *
 * Both helpers never throw.
 */

/** Google's keyless favicon service. `sz=128` keeps the logo crisp in cards. */
const FAVICON_ENDPOINT = 'https://www.google.com/s2/favicons';

/** Ignore favicons bigger than this — they are never a useful logo. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Extract the host from a URL, tolerating bare hosts and relative-ish input. */
function hostOf(pageUrl: string): string {
  const value = (pageUrl ?? '').trim();
  if (!value) return '';
  try {
    return new URL(value).hostname;
  } catch {
    /* not an absolute URL — try common fallbacks below */
  }
  try {
    return new URL(`https://${value}`).hostname;
  } catch {
    /* give up on parsing; fall back to a naive split */
  }
  return value.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? '';
}

/** The keyless Google favicon URL for a page: `...?domain=<host>&sz=128`. */
export function faviconUrlFor(pageUrl: string): string {
  const host = hostOf(pageUrl);
  return `${FAVICON_ENDPOINT}?domain=${host}&sz=128`;
}

/** Base64-encode bytes without relying on `FileReader` (absent in workers). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetch an image and return it as a `data:` URL, or `undefined` on any
 * failure (network error, non-OK status, empty body, or larger than ~2 MB).
 */
export async function fetchAsDataUrl(url: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) return undefined;
    const blob = await response.blob();
    if (!blob || blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return undefined;
    const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
    const buffer = await blob.arrayBuffer();
    return `data:${type};base64,${bytesToBase64(new Uint8Array(buffer))}`;
  } catch {
    return undefined;
  }
}
