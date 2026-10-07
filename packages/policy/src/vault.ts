/**
 * Vault safety.
 *
 * A vault value must never be serialised into a model message. Two layers
 * enforce that:
 *
 * 1. A **registry** of known vault values ({@link registerVaultValue}); any
 *    occurrence of a registered value inside a serialised string is replaced by
 *    the {@link VAULT_SENTINEL}.
 * 2. A **sensitive-key heuristic** over the object being serialised: a value
 *    under a key like `password`, `pan`, `bank`, `dob` is replaced by a
 *    labelled sentinel even if it was never registered.
 *
 * Everything here is total — the walk is cycle-safe, depth-capped, and never
 * throws on garbage input.
 */

/** The marker that replaces a vault value in model-visible text. */
export const VAULT_SENTINEL = '[[VAULT_REDACTED]]';

/** Pattern matching the sentinel, optionally with a `:field` label. */
export const VAULT_SENTINEL_PATTERN = /\[\[VAULT_REDACTED(?::[^\]]*)?\]\]/;

const MAX_DEPTH = 12;
const MAX_REGISTERED = 1024;

const registered = new Set<string>();

/** Lowercased, exact-token keywords that mark a field as secret-bearing. */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'secrets',
  'token',
  'tokens',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'credential',
  'credentials',
  'pan',
  'ssn',
  'aadhaar',
  'aadhar',
  'passport',
  'cvv',
  'cvc',
  'cardnumber',
  'creditcard',
  'debitcard',
  'accountnumber',
  'accno',
  'iban',
  'sortcode',
  'routing',
  'routingnumber',
  'bank',
  'banking',
  'dob',
  'dateofbirth',
  'recoverycode',
  'mfa',
  'taxid',
  'nationalid',
]);

/** Compound (camelCase) keys whose flattened form is secret-bearing. */
const SENSITIVE_COMPOUND: ReadonlySet<string> = new Set([
  'apikey',
  'privatekey',
  'accesskey',
  'secretkey',
  'signingkey',
  'publickey',
  'accountnumber',
  'bankaccount',
  'cardnumber',
  'creditcard',
  'debitcard',
  'routingnumber',
  'securitycode',
  'dateofbirth',
  'recoverycode',
  'nationalid',
  'taxid',
  'accesskeyid',
  'secretaccesskey',
]);

function flattenKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Split a key into lowercase word tokens (handles camelCase and separators). */
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token !== '');
}

/** Does this object key name a secret-bearing field? */
export function isSensitiveKey(key: unknown): boolean {
  if (typeof key !== 'string' || key === '') return false;
  for (const token of keyTokens(key)) {
    if (SENSITIVE_WORDS.has(token)) return true;
  }
  return SENSITIVE_COMPOUND.has(flattenKey(key));
}

function sentinelFor(key: string | null): string {
  return key ? `[[VAULT_REDACTED:${key}]]` : VAULT_SENTINEL;
}

/** Replace every registered vault value inside a string with the sentinel. */
function scrubString(value: string): string {
  let out = value;
  for (const secret of registered) {
    if (secret === '') continue;
    if (out.includes(secret)) out = out.split(secret).join(VAULT_SENTINEL);
  }
  return out;
}

/** Remember a value that must never reach the model. Non-strings are ignored. */
export function registerVaultValue(secret: unknown): void {
  if (typeof secret !== 'string') return;
  if (secret.trim() === '') return;
  if (registered.size >= MAX_REGISTERED && !registered.has(secret)) return;
  registered.add(secret);
}

/** Register several vault values at once (skips anything unusable). */
export function registerVaultValues(values: Iterable<unknown>): void {
  if (values === null || values === undefined) return;
  try {
    for (const value of values) registerVaultValue(value);
  } catch {
    // A non-iterable / throwing iterator must not crash the caller.
  }
}

/** How many vault values are currently registered (for diagnostics/tests). */
export function vaultValuesRegistered(): number {
  return registered.size;
}

/** Forget all registered vault values. */
export function clearVaultValues(): void {
  registered.clear();
}

/** Does the text contain a raw registered vault value? */
export function containsVaultValue(text: unknown): boolean {
  if (typeof text !== 'string' || text === '') return false;
  for (const secret of registered) {
    if (secret !== '' && text.includes(secret)) return true;
  }
  return false;
}

function serialize(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(scrubString(value));
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return String(value);
    case 'bigint':
      return JSON.stringify(`${String(value)}n`);
    case 'undefined':
      return '"undefined"';
    case 'function':
      return '"[function]"';
    case 'symbol':
      return '"[symbol]"';
    default:
      break;
  }

  const obj = value as object;
  if (depth >= MAX_DEPTH) return '"[max depth]"';
  if (seen.has(obj)) return '"[circular]"';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => serialize(item, depth + 1, seen)).join(',')}]`;
    }
    if (obj instanceof Date) {
      const time = obj.getTime();
      return JSON.stringify(Number.isFinite(time) ? obj.toISOString() : 'Invalid Date');
    }
    if (obj instanceof Map) {
      const entries: string[] = [];
      obj.forEach((val, key) => {
        entries.push(`${JSON.stringify(scrubString(String(key)))}:${serialize(val, depth + 1, seen)}`);
      });
      return `{${entries.join(',')}}`;
    }
    if (obj instanceof Set) {
      return `[${Array.from(obj)
        .map((item) => serialize(item, depth + 1, seen))
        .join(',')}]`;
    }

    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record)) {
      const serializedKey = JSON.stringify(scrubString(key));
      if (isSensitiveKey(key)) {
        parts.push(`${serializedKey}:${JSON.stringify(sentinelFor(key))}`);
      } else {
        parts.push(`${serializedKey}:${serialize(record[key], depth + 1, seen)}`);
      }
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Serialise any value for a model message with vault values removed.
 *
 * Strings are scrubbed directly; everything else is serialised (JSON-like) with
 * sensitive keys and registered vault values replaced by
 * {@link VAULT_SENTINEL}. Never throws.
 */
export function redactForModel(value: unknown): string {
  try {
    if (typeof value === 'string') return scrubString(value);
    return serialize(value, 0, new Set<object>());
  } catch {
    return JSON.stringify(VAULT_SENTINEL);
  }
}
