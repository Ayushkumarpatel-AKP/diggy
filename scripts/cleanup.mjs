/**
 * Repo hygiene: removes obviously-not-source junk from the working tree.
 *
 * Same style as scripts/sync-assets.mjs — plain Node ESM, no dependencies,
 * clear console output. Dry-run by default: nothing is deleted unless `--apply`
 * is passed, so it is always safe to run.
 *
 * Flags:
 *   --apply   actually delete the candidates (default is a dry run)
 *   --json    print a machine-readable summary instead of the human report
 *   --force   proceed even when tracked files have staged/unstaged changes
 *
 * Targets (each with a one-line reason):
 *   - untracked junk at the repo root that is obviously not source:
 *     version.err, *.err, *.log, npm/yarn/pnpm-debug.log*, .DS_Store, Thumbs.db
 *   - stray temp directories (tmp/, .tmp/) anywhere outside node_modules
 *
 * Never touched: .git, any node_modules, dist, .output, .turbo, target,
 * .wxt, assets/, docs/ (and their contents). Symlinks are never followed.
 *
 * Conservatism: a candidate is only reported if git says it is NOT tracked,
 * and a temp directory is skipped entirely if it contains tracked files, a
 * protected directory, or any symlink.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const rootReal = safeRealpath(root) ?? root;

/** Directories we never delete and never descend into. */
const PROTECTED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.output',
  '.turbo',
  'target',
  '.wxt',
  'assets',
  'docs',
]);

/** Stray temp directory names (only where they sit outside protected dirs). */
const TEMP_DIR_NAMES = new Set(['tmp', '.tmp']);

/** Root-level junk file matchers, most specific first (first match wins). */
const JUNK_FILE_PATTERNS = [
  { test: (n) => n === 'version.err', reason: 'stray error dump (version.err)' },
  { test: (n) => /^(npm|yarn|pnpm)-debug\.log/.test(n), reason: 'package-manager debug log' },
  { test: (n) => /^(npm|yarn|pnpm)-error\.log/.test(n), reason: 'package-manager error log' },
  { test: (n) => n.endsWith('.log'), reason: 'stray log file (*.log)' },
  { test: (n) => n.endsWith('.err'), reason: 'stray error dump (*.err)' },
  { test: (n) => n === '.DS_Store', reason: 'macOS Finder metadata (.DS_Store)' },
  { test: (n) => n === 'Thumbs.db', reason: 'Windows thumbnail cache (Thumbs.db)' },
];

const argv = new Set(process.argv.slice(2));
const apply = argv.has('--apply');
const force = argv.has('--force');
const json = argv.has('--json');
const mode = apply ? 'apply' : 'dry-run';

/** Path relative to the repo root, always with forward slashes. */
function toRel(abs) {
  return relative(root, abs).split(sep).join('/');
}

function safeRealpath(abs) {
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
}

/** True when `abs` really resolves to somewhere inside the repo. */
function isInsideRoot(abs) {
  const real = safeRealpath(abs);
  if (real === null) return false;
  return real === rootReal || real.startsWith(rootReal + sep);
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

// ---------------------------------------------------------------------------
// Git: the safety net. We refuse to act on a dirty tree (tracked-file changes)
// unless --force, and we never touch anything git says it is tracking.
// ---------------------------------------------------------------------------

function readTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Set(out.split('\0').filter(Boolean).map((p) => p.split(sep).join('/')));
}

function readTrackedChanges() {
  const out = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const changes = [];
  for (const line of out.split('\n')) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    // '??' untracked and '!!' ignored are NOT changes to tracked files.
    if (code === '??' || code === '!!') continue;
    changes.push(line.slice(3).trim());
  }
  return changes;
}

let gitOk = true;
let gitError = '';
let tracked = new Set();
let trackedChanges = [];
try {
  tracked = readTrackedFiles();
  trackedChanges = readTrackedChanges();
} catch (error) {
  gitOk = false;
  gitError = error instanceof Error ? error.message : String(error);
}

let refused = false;
let refuseReason = null;
if (!gitOk) {
  if (!force) {
    refused = true;
    refuseReason = `could not read git state (${gitError}); re-run with --force to proceed anyway`;
  }
} else if (trackedChanges.length > 0 && !force) {
  refused = true;
  refuseReason =
    'the git working tree has staged/unstaged changes to tracked files, so a clean could ' +
    'delete something mid-edit. Commit/stash first, or pass --force to override.';
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const candidates = [];
const skipped = [];

/** Walk a directory and report its size plus anything that makes it unsafe. */
function inspectDir(dirAbs) {
  let bytes = 0;
  let containsProtected = false;
  let containsTracked = false;
  let containsSymlink = false;
  const stack = [dirAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        containsSymlink = true;
        continue;
      }
      if (tracked.has(toRel(abs))) containsTracked = true;
      if (stat.isDirectory()) {
        if (PROTECTED_DIRS.has(entry.name)) {
          containsProtected = true;
          continue;
        }
        stack.push(abs);
      } else {
        bytes += stat.size;
      }
    }
  }
  return { bytes, containsProtected, containsTracked, containsSymlink };
}

// 1. Untracked junk files sitting directly at the repo root.
for (const entry of readdirSync(root, { withFileTypes: true })) {
  const abs = join(root, entry.name);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    continue;
  }
  if (stat.isSymbolicLink()) continue; // never follow / delete links
  if (!stat.isFile()) continue;
  const match = JUNK_FILE_PATTERNS.find((pattern) => pattern.test(entry.name));
  if (!match) continue;
  const rel = entry.name;
  if (tracked.has(rel)) {
    skipped.push({ path: rel, reason: 'tracked by git — left alone' });
    continue;
  }
  if (!isInsideRoot(abs)) {
    skipped.push({ path: rel, reason: 'resolves outside the repo — left alone' });
    continue;
  }
  candidates.push({ path: rel, kind: 'file', reason: match.reason, bytes: stat.size });
}

// 2. Stray temp directories (tmp/, .tmp/) outside node_modules and protected dirs.
const dirStack = [root];
while (dirStack.length > 0) {
  const current = dirStack.pop();
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    const abs = join(current, entry.name);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue; // never follow
    if (!stat.isDirectory()) continue;
    if (PROTECTED_DIRS.has(entry.name)) continue; // never descend
    if (TEMP_DIR_NAMES.has(entry.name)) {
      const rel = toRel(abs);
      const info = inspectDir(abs);
      if (info.containsSymlink) {
        skipped.push({ path: rel, reason: 'contains a symlink — not followed' });
      } else if (info.containsProtected) {
        skipped.push({ path: rel, reason: 'contains a protected directory' });
      } else if (info.containsTracked) {
        skipped.push({ path: rel, reason: 'contains git-tracked files — left alone' });
      } else if (!isInsideRoot(abs)) {
        skipped.push({ path: rel, reason: 'resolves outside the repo — left alone' });
      } else {
        candidates.push({ path: rel, kind: 'dir', reason: 'stray temp directory', bytes: info.bytes });
      }
      continue; // do not descend into the temp dir
    }
    dirStack.push(abs);
  }
}

candidates.sort((a, b) => a.path.localeCompare(b.path));
skipped.sort((a, b) => a.path.localeCompare(b.path));

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

const entries = [];
const removed = [];
if (!refused) {
  for (const candidate of candidates) {
    const record = {
      path: candidate.path,
      kind: candidate.kind,
      action: apply ? 'removed' : 'would-remove',
      reason: candidate.reason,
      bytes: candidate.bytes,
      size: humanBytes(candidate.bytes),
    };
    if (apply) {
      try {
        rmSync(join(root, candidate.path), {
          recursive: candidate.kind === 'dir',
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
        removed.push(record);
        entries.push(record);
      } catch (error) {
        skipped.push({
          path: candidate.path,
          reason: `delete failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else {
      entries.push(record);
    }
  }
}

const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
const summary = {
  ok: !refused,
  mode,
  repoRoot: root,
  refused,
  reason: refuseReason,
  candidateCount: candidates.length,
  removedCount: apply ? removed.length : 0,
  skippedCount: skipped.length,
  totalBytes,
  totalFreed: humanBytes(totalBytes),
  nothingToClean: !refused && entries.length === 0,
  entries,
  skipped,
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (json) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else if (refused) {
  console.error('[diggy] cleanup refused — nothing was deleted.');
  console.error(`[diggy] ${refuseReason}`);
  if (trackedChanges.length > 0) {
    for (const file of trackedChanges.slice(0, 10)) console.error(`         · ${file}`);
    if (trackedChanges.length > 10) {
      console.error(`         · … and ${trackedChanges.length - 10} more`);
    }
  }
} else {
  console.log(`[diggy] cleanup — ${apply ? 'APPLY (deleting)' : 'dry run (nothing will be deleted)'}`);
  if (entries.length === 0) {
    console.log('[diggy] nothing to clean — the working tree is tidy. ✨');
  } else if (apply) {
    console.log(`[diggy] removed ${entries.length} item(s), freed ${humanBytes(totalBytes)}:`);
    for (const entry of entries) console.log(`  - ${entry.path}  (${entry.size}) — ${entry.reason}`);
  } else {
    console.log(`[diggy] would remove ${entries.length} item(s), freeing ${humanBytes(totalBytes)}:`);
    for (const entry of entries) console.log(`  - ${entry.path}  (${entry.size}) — ${entry.reason}`);
    console.log('[diggy] re-run with --apply to delete.');
  }
  if (skipped.length > 0) {
    console.log('[diggy] skipped:');
    for (const entry of skipped) console.log(`  - ${entry.path} — ${entry.reason}`);
  }
}

if (refused) process.exit(1);
