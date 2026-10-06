/**
 * Turn a raw provider failure into one short, human sentence.
 *
 * Users should never see a status code, a JSON body or a stack trace — Diggy
 * says what happened and what to do, and the raw text stays in the logs.
 */

type Kind =
  | 'rate-limit'
  | 'auth'
  | 'model'
  | 'network'
  | 'server'
  | 'empty'
  | 'unknown';

function kindOf(raw: string): Kind {
  const text = raw.toLowerCase();
  if (/rate limit|429|too many requests|quota|exceeded|tokens per minute|\btpm\b|\brpd\b/.test(text)) {
    return 'rate-limit';
  }
  if (/401|403|unauthor|invalid.*(api|key)|api key|forbidden|permission/.test(text)) return 'auth';
  if (/404|not found|decommissioned|does not exist|model.*(invalid|unknown)|no such model/.test(text)) {
    return 'model';
  }
  if (
    /failed to fetch|fetch failed|network|econnrefused|econnreset|timeout|timed out|abort|dns|offline|socket hang up/.test(
      text,
    )
  ) {
    return 'network';
  }
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|overloaded/.test(text)) return 'server';
  if (/empty (reply|response)|no content|nothing to add/.test(text)) return 'empty';
  return 'unknown';
}

export interface FriendlyErrorOptions {
  /** The provider that failed last, for a slightly more specific sentence. */
  provider?: string;
  /** True when Diggy already tried the fallback provider. */
  switched?: boolean;
}

/** A short message safe to show in the chat bubble. */
export function friendlyError(error: unknown, options: FriendlyErrorOptions = {}): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  switch (kindOf(raw)) {
    case 'rate-limit':
      return options.switched
        ? '⏳ Dono brain busy hain (free limit). Ek minute ruk ke phir bolo — main turant reply karunga.'
        : '⏳ Thoda load zyada hai (free limit). Ek minute ruk ke phir bolo, ya ⚙ me dusri key daal do.';
    case 'auth':
      return '🔑 API key kaam nahi kar rahi. ⚙ Settings khol ke key dobara check kar lo.';
    case 'model':
      return '🤖 Ye model ab available nahi hai. ⚙ Settings me model badal do (jaise openai/gpt-oss-120b).';
    case 'network':
      return '🌐 Connection me dikkat lag rahi hai. Net check karke ek baar phir bolo.';
    case 'server':
      return '😴 Provider ki taraf se server busy hai. Thodi der me phir try karo.';
    case 'empty':
      return '🤔 Model ne kuch jawab nahi diya — ek baar phir bol do.';
    default:
      return '😅 Kuch gadbad ho gayi. Ek baar phir bolo — na ho to ⚙ settings check kar lo.';
  }
}

/** A compact one-line summary for logs (never shown to the user). */
export function errorDetail(error: unknown, limit = 200): string {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).replace(/\s+/g, ' ').trim();
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}
