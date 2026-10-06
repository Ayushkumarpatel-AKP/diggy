import { afterAll, describe, expect, it } from 'vitest';

import { createContext } from '../src/config.js';
import { parseMeta, parseYouTubeFeed } from '../src/routes/preview.js';
import { buildServer } from '../src/server.js';

const CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const VIDEO_ID = 'dQw4w9WgXcQ';

/** A trimmed-down copy of the real Atom feed layout. */
const FEED_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}"/>
  <id>yt:channel:${CHANNEL_ID}</id>
  <yt:channelId>${CHANNEL_ID}</yt:channelId>
  <title>Google Developers</title>
  <entry>
    <id>yt:video:${VIDEO_ID}</id>
    <yt:videoId>${VIDEO_ID}</yt:videoId>
    <yt:channelId>${CHANNEL_ID}</yt:channelId>
    <title>Hello World</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${VIDEO_ID}"/>
    <published>2024-02-01T10:00:00+00:00</published>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg" width="480" height="360"/>
    </media:group>
  </entry>
</feed>`;

const HTML_FIXTURE = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Fallback Title</title>
  <meta name="description" content="Fallback description">
  <meta property="og:title" content="OG Title">
  <meta property="og:description" content="OG description">
  <meta property="og:image" content="/assets/cover.png">
  <link rel="icon" href="/favicon.ico">
</head><body>hi</body></html>`;

describe('parseYouTubeFeed', () => {
  it('extracts the newest video from an Atom feed', () => {
    expect(parseYouTubeFeed(FEED_FIXTURE)).toEqual({
      channelId: CHANNEL_ID,
      videoId: VIDEO_ID,
      title: 'Hello World',
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      thumbnail: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
      published: '2024-02-01T10:00:00+00:00',
    });
  });

  it('returns undefined for a feed with no entries', () => {
    expect(parseYouTubeFeed('<feed><title>empty</title></feed>')).toBeUndefined();
  });
});

describe('parseMeta', () => {
  it('prefers OpenGraph over the <title> tag and resolves relative URLs', () => {
    expect(parseMeta(HTML_FIXTURE, 'https://example.com/post/1')).toEqual({
      title: 'OG Title',
      description: 'OG description',
      image: 'https://example.com/assets/cover.png',
      faviconUrl: 'https://example.com/favicon.ico',
    });
  });

  it('falls back to the Google favicon service when no icon link exists', () => {
    const meta = parseMeta('<title>Hi</title><meta name="description" content="d">', 'https://news.ycombinator.com/');
    expect(meta.title).toBe('Hi');
    expect(meta.faviconUrl).toBe('https://www.google.com/s2/favicons?domain=news.ycombinator.com&sz=64');
  });
});

describe('preview routes', () => {
  const app = buildServer({ context: createContext({ dbPath: ':memory:' }) });
  afterAll(async () => {
    await app.close();
  });

  it('derives the favicon URL from a page URL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/favicon?url=https%3A%2F%2Fnews.ycombinator.com%2Fitem%3Fid%3D1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      faviconUrl: 'https://www.google.com/s2/favicons?domain=news.ycombinator.com&sz=64',
    });
  });

  it('rejects a request without a url', async () => {
    const response = await app.inject({ method: 'GET', url: '/favicon' });
    expect(response.statusCode).toBe(400);
  });

  it('parses /meta from an inline HTML fixture (no network)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/meta?url=${encodeURIComponent('https://example.com/post/1')}&html=${encodeURIComponent(HTML_FIXTURE)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      title: 'OG Title',
      description: 'OG description',
      image: 'https://example.com/assets/cover.png',
      faviconUrl: 'https://example.com/favicon.ico',
    });
  });
});
