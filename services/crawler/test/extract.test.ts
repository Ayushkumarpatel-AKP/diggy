import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { extractFromHtml, htmlToMarkdown } from '../src/extract.js';
import { inject } from './helpers.js';

const FIXTURE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Diggy Research Notes</title>
    <meta name="description" content="A local fixture used by crawler tests." />
    <script>window.__tracking = true;</script>
  </head>
  <body>
    <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
    <article>
      <h1>Diggy Research Notes</h1>
      <p>
        Diggy is a local-first research assistant that crawls pages and turns them into
        clean, model-friendly Markdown. This fixture exercises the readability pipeline
        with an <strong>important bold claim</strong> and a link to the
        <a href="https://example.com/diggy">Diggy docs</a>. The converter must keep the
        structure of headings, emphasis, lists, quotes and code while stripping the
        surrounding navigation chrome that nobody wants inside a prompt.
      </p>
      <h2>Key Findings</h2>
      <ul>
        <li>First bullet about extraction quality.</li>
        <li>Second bullet about robots handling.</li>
        <li>Third bullet about graceful degradation.</li>
      </ul>
      <p>
        The pipeline is <em>fully offline</em> for extraction: no network calls happen in
        the unit tests. Readability decides what the main article is, and a small
        hand-written converter turns that HTML into tidy Markdown with deterministic
        whitespace, predictable headings and no leftover markup.
      </p>
      <blockquote>
        <p>Respect robots.txt and rate limits, always.</p>
      </blockquote>
      <h2>Example</h2>
      <pre><code class="language-ts">const result = extractFromHtml(html, url);
console.log(result.title);</code></pre>
      <p>
        Finally we add enough prose so that the readability heuristic is confident this
        is the real article and not a teaser. Mentions of crawling, markdown, readability,
        headings, emphasis, lists, quotes and code fences all help pad the character count
        well past the default threshold used by the library at runtime, so the extractor
        picks the article instead of the whole document.
      </p>
    </article>
    <footer><p>Copyright 2026 Diggy</p></footer>
  </body>
</html>`;

const app = buildServer();

afterAll(async () => {
  await app.close();
});

describe('POST /extract (local HTML fixture, no network)', () => {
  it('returns clean markdown from a raw HTML string', async () => {
    const response = await inject(app, {
      method: 'POST',
      url: '/extract',
      payload: { html: FIXTURE, url: 'https://example.com/notes' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { title: string; markdown: string };

    expect(body.title).toBe('Diggy Research Notes');

    const markdown = body.markdown;
    expect(markdown.length).toBeGreaterThan(200);
    expect(markdown).toContain('Key Findings');
    expect(markdown).toContain('**important bold claim**');
    expect(markdown).toContain('[Diggy docs](https://example.com/diggy)');
    expect(markdown).toContain('First bullet about extraction quality.');
    expect(markdown).toContain('*fully offline*');
    expect(markdown).toContain('Respect robots.txt and rate limits, always.');
    expect(markdown).toContain('```');
    expect(markdown).toContain('extractFromHtml(html, url);');

    // No leftover raw tags and no script content leaked through.
    expect(markdown).not.toContain('<p>');
    expect(markdown).not.toContain('<strong>');
    expect(markdown).not.toContain('__tracking');
  });

  it('rejects a request with neither html nor url', async () => {
    const response = await inject(app, { method: 'POST', url: '/extract', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe('extractFromHtml', () => {
  it('extracts title and markdown from an article', () => {
    const result = extractFromHtml(FIXTURE);
    expect(result.title).toBe('Diggy Research Notes');
    expect(result.markdown).toContain('Key Findings');
  });

  it('falls back gracefully when there is no readable article', () => {
    const result = extractFromHtml('<html><body><p>Hello <b>world</b></p></body></html>');
    expect(result.markdown).toContain('Hello');
    expect(result.markdown).toContain('**world**');
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings, links and lists', () => {
    const md = htmlToMarkdown(
      '<h1>Title</h1><p>See <a href="https://a.test/x">X</a>.</p><ul><li>One</li><li>Two</li></ul>',
    );
    expect(md).toContain('# Title');
    expect(md).toContain('[X](https://a.test/x)');
    expect(md).toContain('- One');
    expect(md).toContain('- Two');
  });

  it('keeps a fenced code block language hint and resolves relative links', () => {
    const md = htmlToMarkdown(
      '<pre><code class="language-ts">const a = 1;</code></pre><p><a href="/rel">rel</a></p>',
      'https://example.com/base/',
    );
    expect(md).toContain('```ts');
    expect(md).toContain('const a = 1;');
    expect(md).toContain('(https://example.com/rel)');
  });
});
