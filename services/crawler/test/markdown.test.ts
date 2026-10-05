import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

const app = buildServer();

afterAll(async () => {
  await app.close();
});

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

describe('POST /markdown', () => {
  it('passes plain text through', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/markdown',
      payload: { base64: b64('line one\nline two\n'), filename: 'notes.txt' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { markdown: string };
    expect(body.markdown).toBe('line one\nline two');
  });

  it('passes markdown through unchanged', async () => {
    const source = '# Title\n\n- a\n- b\n';
    const response = await app.inject({
      method: 'POST',
      url: '/markdown',
      payload: { base64: b64(source), filename: 'README.md' },
    });
    const body = response.json() as { markdown: string };
    expect(body.markdown).toContain('# Title');
    expect(body.markdown).toContain('- a');
  });

  it('converts html documents via the extractor', async () => {
    const html = '<html><head><title>Doc</title></head><body><article><p>Hello <b>world</b> from HTML.</p></article></body></html>';
    const response = await app.inject({
      method: 'POST',
      url: '/markdown',
      payload: { base64: b64(html), filename: 'page.html' },
    });
    const body = response.json() as { markdown: string };
    expect(body.markdown).toContain('Hello');
    expect(body.markdown).toContain('**world**');
  });

  it('rejects a request without base64 content', async () => {
    const response = await app.inject({ method: 'POST', url: '/markdown', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /health', () => {
  it('reports ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });
});
