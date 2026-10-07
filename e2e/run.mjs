#!/usr/bin/env node
/**
 * Diggy e2e runner — drives the real built extension in Chromium.
 *
 *   node e2e/run.mjs                 # run every test
 *   node e2e/run.mjs --test=bot-renders
 *   node e2e/run.mjs --headed        # watch it happen
 *   node e2e/run.mjs --list
 *
 * Individual tests are individually runnable via `--test=<name>`. Tests skip
 * cleanly (rather than fail) when the extension is not built or Playwright
 * cannot be resolved.
 *
 * No dependencies: Playwright is reused from `services/crawler`.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEnv, SkipError } from './harness.mjs';

const TESTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests');

function parseArgs(argv) {
  const options = { headed: false, list: false, selected: [] };
  for (const arg of argv) {
    if (arg === '--headed') options.headed = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--test=')) {
      options.selected.push(
        ...arg
          .slice('--test='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }
  return options;
}

async function loadTests() {
  const files = (await readdir(TESTS_DIR)).filter((f) => f.endsWith('.mjs')).sort();
  const tests = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(TESTS_DIR, file)).href);
    if (typeof mod.run !== 'function') continue;
    tests.push({ name: mod.name ?? file.replace(/\.mjs$/, ''), description: mod.description ?? '', run: mod.run });
  }
  return tests;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log('Usage: node e2e/run.mjs [--test=<name>[,<name>]] [--headed] [--list]');
    return 0;
  }

  const tests = await loadTests();
  if (options.list) {
    console.log('Diggy e2e tests:');
    for (const test of tests) console.log(`  - ${test.name}${test.description ? `  (${test.description})` : ''}`);
    return 0;
  }

  const selected = options.selected.length
    ? tests.filter((test) => options.selected.includes(test.name))
    : tests;
  if (selected.length === 0) {
    console.error(`No tests matched: ${options.selected.join(', ')}`);
    return 1;
  }

  console.log('Diggy e2e — real extension in Chromium');
  const env = await createEnv({ headed: options.headed });
  console.log(`  extension build : ${env.built ? 'present (apps/extension/.output/chrome-mv3)' : 'MISSING'}`);
  console.log(`  playwright-core : ${env.playwright ? 'resolved' : 'MISSING'}`);
  console.log(`  fixtures        : ${env.fixtures.baseUrl}`);
  console.log('');

  const rows = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  try {
    for (const test of selected) {
      const started = Date.now();
      try {
        const detail = await test.run(env);
        const ms = Date.now() - started;
        passed += 1;
        rows.push({ status: 'PASS', name: test.name, detail: detail ?? '', ms });
        console.log(`  PASS  ${test.name}  (${ms}ms) — ${detail ?? ''}`);
      } catch (error) {
        const ms = Date.now() - started;
        if (error instanceof SkipError || error?.skip) {
          skipped += 1;
          rows.push({ status: 'SKIP', name: test.name, detail: error.message, ms });
          console.log(`  SKIP  ${test.name} — ${error.message}`);
        } else {
          failed += 1;
          const message = error?.message ?? String(error);
          rows.push({ status: 'FAIL', name: test.name, detail: message, ms });
          console.log(`  FAIL  ${test.name}  (${ms}ms) — ${message}`);
          if (process.env.DIGGY_E2E_VERBOSE) console.log(error?.stack ?? '');
        }
      }
    }
  } finally {
    await env.dispose();
  }

  const width = Math.max(6, ...rows.map((row) => row.name.length));
  console.log('\n' + pad('RESULT', 6) + '  ' + pad('TEST', width) + '  DETAIL');
  for (const row of rows) {
    console.log(`${pad(row.status, 6)}  ${pad(row.name, width)}  ${row.detail}`);
  }
  console.log('');
  console.log(
    `${rows.length} test(s) · ${passed} passed · ${skipped} skipped · ${failed} failed`,
  );
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('e2e runner crashed:', error?.stack ?? String(error));
    process.exit(1);
  },
);
