/**
 * `reach` provider — a thin adapter over the locally installed `agent-reach`
 * capability layer plus the concrete tools it unlocks:
 *
 * - `agent-reach doctor`  → report which channels are available (✅).
 * - `yt-dlp`              → YouTube metadata + subtitles (transcripts).
 * - RSS/Atom              → feeds, parsed by the pure {@link parseFeed} helper.
 * - Jina Reader           → `https://r.jina.ai/<url>` last-resort reader.
 *
 * Everything here is defensive: child processes always run through
 * {@link execCapture} with an argument **array** (never a shell string) and a
 * hard timeout, and the public helpers never throw — they return
 * `undefined`/`[]`/`false` on any failure.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { isNetworkDisabled } from '../search.js';
import type {
  CrawlInput,
  CrawlProvider,
  FetchLike,
  ProviderExtract,
  ProviderPage,
} from './types.js';

/** Stable provider identifier. */
export const REACH_PROVIDER_NAME = 'reach';

/** Jina Reader origin used by {@link readWithReach}. */
export const JINA_READER_BASE = 'https://r.jina.ai/';

/** How long a {@link probeReach} result is reused before re-running `doctor`. */
export const PROBE_TTL_MS = 60_000;

/**
 * Wall-clock budget for `agent-reach doctor`.
 *
 * The spec asked for "~8s", but the real command performs several live network
 * probes and measured ~8.5s warm on the development machine, so the ceiling is
 * bumped slightly to avoid a false "unavailable" verdict on a cold request.
 */
export const DOCTOR_TIMEOUT_MS = 12_000;

/** Wall-clock budget for a single `yt-dlp` invocation. */
export const TRANSCRIPT_TIMEOUT_MS = 60_000;

/** Wall-clock budget for fetching a feed's XML when the CLI cannot be used. */
export const FEED_TIMEOUT_MS = 15_000;

/** Wall-clock budget for the Jina Reader request. */
export const JINA_TIMEOUT_MS = 20_000;

const USER_AGENT = 'Mozilla/5.0 (compatible; diggy-reach/0.1; +https://github.com/)';

/** Result of {@link probeReach}. */
export interface ReachProbeResult {
  available: boolean;
  version?: string;
  channels?: Record<string, boolean>;
}

/** Result of {@link fetchTranscript}. */
export interface TranscriptResult {
  title?: string;
  language?: string;
  text: string;
}

/** A single feed entry. */
export interface FeedItem {
  title: string;
  link: string;
  published?: string;
  summary?: string;
}

/** Result of {@link fetchFeed}. */
export interface FeedResult {
  title?: string;
  items: FeedItem[];
}

/** Result of {@link readWithReach}. */
export interface ReadResult {
  title?: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Child-process plumbing
// ---------------------------------------------------------------------------

interface ExecResult {
  code: number;
  notFound: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run a program with an argument **array** (never a shell) and a hard timeout.
 * Resolves with captured output and never rejects.
 */
function execCapture(command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          timeout: Math.max(1, timeoutMs),
          killSignal: 'SIGKILL',
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            NO_COLOR: '1',
          },
        },
        (error, stdout, stderr) => {
          const failure = error as (Error & { code?: string | number; killed?: boolean }) | null;
          resolve({
            code: typeof failure?.code === 'number' ? failure.code : failure ? 1 : 0,
            notFound: failure?.code === 'ENOENT',
            timedOut: Boolean(failure?.killed),
            stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
            stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          });
        },
      );
    } catch (error) {
      resolve({ code: 1, notFound: false, timedOut: false, stdout: '', stderr: String(error) });
    }
  });
}

/** Try each candidate command in order until one actually exists on disk. */
async function execFirst(
  commands: string[],
  args: string[],
  timeoutMs: number,
): Promise<ExecResult | undefined> {
  for (const command of commands) {
    const result = await execCapture(command, args, timeoutMs);
    if (!result.notFound) return result;
  }
  return undefined;
}

/** Install directories that hold Python console scripts (plus POSIX bins). */
function scriptsDirectories(): string[] {
  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const versions = ['Python313', 'Python312', 'Python311', 'Python310'];
  const dirs: string[] = [];
  for (const root of roots) {
    for (const version of versions) {
      dirs.push(join(root, 'Python', version, 'Scripts'));
      dirs.push(join(root, 'Programs', 'Python', version, 'Scripts'));
    }
  }
  if (process.platform !== 'win32') {
    dirs.push(join(homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin');
  }
  return dirs;
}

/** File names to look for on Windows (PATHEXT-style) vs. POSIX. */
function executableNames(name: string): string[] {
  if (process.platform === 'win32') {
    return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
  }
  return [name];
}

/** Absolute candidate paths for a tool installed outside `PATH`. */
function candidatePaths(name: string): string[] {
  const paths: string[] = [];
  for (const dir of scriptsDirectories()) {
    for (const exe of executableNames(name)) {
      paths.push(join(dir, exe));
    }
  }
  return paths;
}

/** Whether `name` resolves on `PATH` (filesystem scan, never spawns). */
function onPath(name: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const exe of executableNames(name)) {
      if (existsSync(join(dir, exe))) return true;
    }
  }
  return false;
}

/** Cheap synchronous existence check — used by the provider's `available()`. */
function executableExists(name: string): boolean {
  return onPath(name) || candidatePaths(name).some((candidate) => existsSync(candidate));
}

/** Ordered commands to try for a tool: ``name`` first, then known install dirs. */
function commandCandidates(name: string): string[] {
  return [name, ...candidatePaths(name)];
}

// ---------------------------------------------------------------------------
// feedparser.py probe (agent-reach "doctor")
// ---------------------------------------------------------------------------

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const CHANNEL_LINE = /^\s*(✅|\[!\]|\[X\])\s+(.*)$/;
const CHANNEL_SEPARATOR = /\s[—–]\s/;

/**
 * Keyword → stable channel key. Ordered so that labels which mention several
 * domains (e.g. "B站视频、字幕和搜索") resolve to their primary channel first.
 */
const CHANNEL_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/youtube/i, 'youtube'],
  [/github/i, 'github'],
  [/bilibili|b\s*站/i, 'bilibili'],
  [/v2ex/i, 'v2ex'],
  [/小红书|xiaohongshu/i, 'xiaohongshu'],
  [/linkedin/i, 'linkedin'],
  [/zhipin|直聘/i, 'boss'],
  [/小宇宙|xiaoyuzhou/i, 'xiaoyuzhou'],
  [/雪球|xueqiu/i, 'xueqiu'],
  [/twitter|推文/i, 'twitter'],
  [/reddit/i, 'reddit'],
  [/facebook/i, 'facebook'],
  [/instagram/i, 'instagram'],
  [/jina|任意网页|web\s*page|\bweb\b/i, 'web'],
  [/rss|atom|订阅源|\bfeed\b/i, 'rss'],
  [/exa|语义搜索|semantic|\bsearch\b/i, 'search'],
];

/**
 * Map an `agent-reach doctor` channel label to a stable, lowercase key.
 * Unknown labels are returned verbatim so nothing silently disappears.
 */
export function reachChannelKey(label: string): string {
  const normalized = typeof label === 'string' ? label.trim() : '';
  if (!normalized) return '';
  for (const [pattern, key] of CHANNEL_KEYWORDS) {
    if (pattern.test(normalized)) return key;
  }
  return normalized;
}

/**
 * Parse the rendered `agent-reach doctor` text report into
 * `{ channelKey: available }`.
 *
 * Only lines that begin with a status marker (`✅` / `[!]` / `[X]`) **and**
 * carry the `label — message` separator are treated as channels, which makes
 * the parser immune to the report's wrapped continuation lines and section
 * headers. Pure and offline; exported for tests.
 */
export function parseDoctorOutput(text: string): Record<string, boolean> {
  const channels: Record<string, boolean> = {};
  if (typeof text !== 'string' || !text) return channels;

  for (const rawLine of text.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
    const match = CHANNEL_LINE.exec(rawLine.trimEnd());
    if (!match) continue;

    const marker = match[1] ?? '';
    const rest = (match[2] ?? '').trim();
    if (!rest) continue;

    const separator = CHANNEL_SEPARATOR.exec(rest);
    if (!separator || separator.index === undefined) continue; // e.g. "✅ 装好即用："

    const label = rest.slice(0, separator.index).trim();
    const key = reachChannelKey(label);
    if (!key) continue;

    const ok = marker === '✅';
    // A channel reported more than once counts as available if any line says so.
    channels[key] = channels[key] === true ? true : ok;
  }

  return channels;
}

function extractVersion(output: string): string | undefined {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.]+)?/.exec(output ?? '');
  return match ? match[0] : undefined;
}

interface CachedProbe {
  at: number;
  result: ReachProbeResult;
}

let cachedProbe: CachedProbe | null = null;

/** Drop the cached probe (used by tests and to force a re-check). */
export function resetReachProbeCache(): void {
  cachedProbe = null;
}

/** Synchronous availability used by {@link CrawlProvider.available}. */
function reachAvailableSync(): boolean {
  if (isNetworkDisabled()) return false;
  if (cachedProbe && Date.now() - cachedProbe.at < PROBE_TTL_MS) {
    return cachedProbe.result.available;
  }
  return executableExists('agent-reach');
}

/** Summary row for the provider listings. */
export function reachProviderSummary(): { name: string; available: boolean } {
  return { name: REACH_PROVIDER_NAME, available: reachAvailableSync() };
}

async function runReachProbe(timeoutMs: number): Promise<ReachProbeResult> {
  if (isNetworkDisabled() || !executableExists('agent-reach')) {
    return { available: false };
  }

  const commands = commandCandidates('agent-reach');
  const [doctor, versionRun] = await Promise.all([
    execFirst(commands, ['doctor'], timeoutMs),
    execFirst(commands, ['--version'], Math.min(timeoutMs, 4_000)),
  ]);

  const channels = doctor ? parseDoctorOutput(doctor.stdout) : {};
  const version = versionRun ? extractVersion(versionRun.stdout) : undefined;

  return {
    available: true,
    ...(version ? { version } : {}),
    channels,
  };
}

/**
 * Probe the `agent-reach` CLI: run `agent-reach doctor`, parse which channels
 * are ✅, and cache the result for {@link PROBE_TTL_MS} so we never spawn a
 * Python process per request.
 *
 * Returns `{ available: false }` when the CLI is missing, offline, or the probe
 * fails for any reason — it never throws.
 */
export async function probeReach(
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<ReachProbeResult> {
  const now = Date.now();
  if (!options.force && cachedProbe && now - cachedProbe.at < PROBE_TTL_MS) {
    return cachedProbe.result;
  }

  let result: ReachProbeResult;
  try {
    result = await runReachProbe(options.timeoutMs ?? DOCTOR_TIMEOUT_MS);
  } catch {
    result = { available: false };
  }

  cachedProbe = { at: Date.now(), result };
  return result;
}

// ---------------------------------------------------------------------------
// yt-dlp transcripts
// ---------------------------------------------------------------------------

const SUBTITLE_FILE = /\.(?:vtt|srt|srv[123])$/i;
const LANGUAGE_IN_FILENAME = /\.([a-z]{2,3}(?:-[a-z0-9]+)*)\.(?:vtt|srt|srv[123])$/i;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/** Decode the common XML/HTML entities (numeric + a small named subset). */
function decodeEntities(value: string): string {
  if (typeof value !== 'string' || value.indexOf('&') === -1) return value ?? '';
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.charCodeAt(0) === 35 /* '#' */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function languageFromFilename(name: string): string | undefined {
  const match = LANGUAGE_IN_FILENAME.exec(name ?? '');
  const language = match?.[1]?.toLowerCase();
  return language && language.length > 0 ? language : undefined;
}

function pickSubtitleFile(files: string[], lang: string): string | undefined {
  if (files.length === 0) return undefined;
  const sorted = [...files].sort();
  const wanted = lang.toLowerCase();
  const exact = sorted.find((file) => languageFromFilename(file) === wanted);
  if (exact) return exact;
  const partial = sorted.find((file) => file.toLowerCase().includes(`.${wanted}.`));
  return partial ?? sorted[0];
}

function lastNonEmptyLine(value: string): string | undefined {
  const lines = (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

/**
 * Fetch a YouTube transcript via `yt-dlp`.
 *
 * Runs:
 * ```
 * yt-dlp --skip-download --no-simulate --no-warnings --no-progress --no-playlist \
 *        --write-subs --write-auto-subs --sub-format vtt --sub-langs <lang> \
 *        --output <tmp>/%(id)s.%(ext)s --print %(title)s <url>
 * ```
 *
 * `--no-simulate` is required because `--print` otherwise implies a simulation
 * and would skip writing the subtitle files. The downloaded `.vtt` is reduced
 * to plain prose by {@link stripVtt}. Returns `undefined` (never throws) on any
 * failure — missing tooling, no captions, timeout, offline, …
 */
export async function fetchTranscript(
  url: string,
  options: { lang?: string } = {},
): Promise<TranscriptResult | undefined> {
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target || isNetworkDisabled()) return undefined;

  const lang =
    typeof options.lang === 'string' && options.lang.trim().length > 0
      ? options.lang.trim()
      : 'en';

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'diggy-reach-'));
    const args = [
      '--skip-download',
      '--no-simulate',
      '--no-warnings',
      '--no-progress',
      '--no-playlist',
      '--write-subs',
      '--write-auto-subs',
      '--sub-format',
      'vtt',
      '--sub-langs',
      lang,
      '--output',
      join(dir, '%(id)s.%(ext)s'),
      '--print',
      '%(title)s',
      target,
    ];

    const run = await execFirst(commandCandidates('yt-dlp'), args, TRANSCRIPT_TIMEOUT_MS);
    if (!run) return undefined;

    const files = (await safeReaddir(dir)).filter((name) => SUBTITLE_FILE.test(name));
    const chosen = pickSubtitleFile(files, lang);
    if (!chosen) return undefined;

    const text = stripVtt(await readFile(join(dir, chosen), 'utf8'));
    if (!text) return undefined;

    const title = lastNonEmptyLine(run.stdout);
    return {
      ...(title ? { title } : {}),
      language: languageFromFilename(chosen) ?? lang,
      text,
    };
  } catch {
    return undefined;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Subtitle (WebVTT / SRT / srv) → plain prose
// ---------------------------------------------------------------------------

const CUE_TIMING = /^(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->/;
const INLINE_MARKUP = /<[^>]*>/g;

/**
 * Reduce a WebVTT (or SRT / YouTube `srv*`) subtitle document to plain prose:
 * no `WEBVTT` header, no cue timings/settings, no markup and no repeated
 * lines. Pure and offline; exported for tests.
 */
export function stripVtt(vtt: string): string {
  if (typeof vtt !== 'string' || !vtt.trim()) return '';

  const normalized = vtt
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    // srv1/srv3 XML cues: "</text>"/"</p>" separate lines of prose.
    .replace(/<\/(?:text|p)>/gi, '\n');

  const seen = new Set<string>();
  const out: string[] = [];

  for (const rawLine of normalized.split('\n')) {
    const line = decodeEntities(rawLine.replace(INLINE_MARKUP, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    if (/^WEBVTT\b/i.test(line)) continue;
    if (/^(?:NOTE|STYLE|REGION)\b/i.test(line)) continue;
    if (/^(?:Kind|Language|X-TIMESTAMP-MAP)\s*:/i.test(line)) continue;
    if (CUE_TIMING.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // SRT cue index
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// RSS / Atom
// ---------------------------------------------------------------------------

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** Strip tags, decode entities and collapse whitespace into a single line. */
function plainText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(block: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i');
    const match = pattern.exec(block);
    if (match) {
      const value = plainText(stripCdata(match[1] ?? ''));
      if (value) return value;
    }
  }
  return undefined;
}

function attribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = pattern.exec(attrs);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? undefined;
}

/** Every `<link>` with a `href` (i.e. Atom-style links). */
function atomLinks(block: string): { href: string; rel: string }[] {
  const links: { href: string; rel: string }[] = [];
  const pattern = /<link\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    const attrs = match[1] ?? '';
    const href = attribute(attrs, 'href');
    if (!href) continue;
    links.push({ href: decodeEntities(href), rel: attribute(attrs, 'rel') ?? 'alternate' });
  }
  return links;
}

function linkOf(block: string): string | undefined {
  const links = atomLinks(block);
  const preferred = links.find((link) => link.rel === 'alternate') ?? links[0];
  if (preferred?.href) return preferred.href;

  const direct = firstTag(block, ['link']);
  if (direct && /^https?:\/\//i.test(direct)) return direct;

  const guid = firstTag(block, ['guid', 'id']);
  if (guid && /^https?:\/\//i.test(guid)) return guid;

  return direct;
}

function collectBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

/** Best-effort feed/channel title (not part of {@link parseFeed}'s contract). */
function feedTitle(xml: string): string | undefined {
  const channel = /<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel\s*>/i.exec(xml)?.[1];
  const feed = /<feed(?:\s[^>]*)?>([\s\S]*?)<\/feed\s*>/i.exec(xml)?.[1];
  return firstTag(channel ?? feed ?? xml, ['title']);
}

function feedItem(block: string): FeedItem | undefined {
  const title = firstTag(block, ['title']) ?? '';
  const link = linkOf(block) ?? '';
  if (!title && !link) return undefined;

  const published = firstTag(block, ['pubDate', 'published', 'updated', 'dc:date', 'date']);
  const summary = firstTag(block, [
    'description',
    'summary',
    'content:encoded',
    'content',
    'media:description',
  ]);

  const item: FeedItem = { title: title || link, link };
  if (published) item.published = published;
  if (summary) item.summary = summary;
  return item;
}

/**
 * Parse an RSS 2.0 or Atom feed document into a list of entries.
 *
 * Handles `<item>` (RSS) and `<entry>` (Atom), Atom `<link href>` attributes,
 * CDATA sections and the common named/numeric entities. Pure and offline;
 * exported so it can be exercised with fixtures and used as the fallback
 * parser for {@link fetchFeed}.
 *
 * Returns `[]` for malformed / non-feed input and never throws.
 */
export function parseFeed(xml: string, max = 10): FeedItem[] {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 10;

  try {
    let blocks = collectBlocks(xml, 'item');
    if (blocks.length === 0) blocks = collectBlocks(xml, 'entry');

    const items: FeedItem[] = [];
    for (const block of blocks) {
      if (items.length >= limit) break;
      const item = feedItem(block);
      if (item) items.push(item);
    }
    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Feed + reader fetching
// ---------------------------------------------------------------------------

/**
 * Fetch and parse an RSS/Atom feed.
 *
 * `agent-reach` does not expose a feed-fetch subcommand (verified against
 * `agent-reach --help`), so this fetches the XML directly and parses it with
 * {@link parseFeed}. Returns `undefined` (never throws) on failure or offline.
 */
export async function fetchFeed(
  url: string,
  options: { max?: number; timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<FeedResult | undefined> {
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target || isNetworkDisabled()) return undefined;

  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FEED_TIMEOUT_MS);
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept:
          'application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain, */*',
      },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;

    const xml = await response.text();
    const items = parseFeed(xml, options.max ?? 10);
    const title = feedTitle(xml);
    return { ...(title ? { title } : {}), items };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function titleFromJina(text: string): string | undefined {
  const match = /^Title:\s*(.+)$/m.exec(text);
  const title = match?.[1]?.trim();
  return title && title.length > 0 ? title : undefined;
}

/**
 * Read an arbitrary web page through the Jina Reader proxy
 * (`https://r.jina.ai/<url>`). Last-resort reader; returns `undefined` (never
 * throws) on failure or when the network is disabled.
 */
export async function readWithReach(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<ReadResult | undefined> {
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target || isNetworkDisabled()) return undefined;

  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? JINA_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${JINA_READER_BASE}${target}`, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;

    const text = await response.text();
    if (!text.trim()) return undefined;

    const title = titleFromJina(text);
    return { ...(title ? { title } : {}), text };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Create the `reach` provider.
 *
 * The provider is intentionally read-only: `extract()` reads a single page via
 * the Jina Reader and `crawl()` returns that one page (the capability layer does
 * not spider). `available()` mirrors the cached {@link probeReach} verdict and
 * falls back to a cheap on-disk check so listing it never spawns Python.
 */
export function createReachProvider(): CrawlProvider {
  async function extract(url: string): Promise<ProviderExtract> {
    const result = await readWithReach(url);
    if (!result) {
      throw new Error(`reach could not read ${url}.`);
    }
    return { title: result.title ?? url, markdown: result.text };
  }

  async function crawl(input: CrawlInput): Promise<ProviderPage[]> {
    const page = await extract(input.url);
    return [{ url: input.url, title: page.title, markdown: page.markdown }];
  }

  return {
    name: REACH_PROVIDER_NAME,
    available: () => reachAvailableSync(),
    crawl,
    extract,
  };
}
