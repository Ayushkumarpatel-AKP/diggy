import { describe, expect, it } from 'vitest';
import { parseChannelVideosPage } from '../src/routes/preview.js';

/**
 * A video's `contentId` sits thousands of characters *after* its title in the
 * channel page's JSON (the metadata block comes first). The parser must search
 * up to the next lockup — a fixed-size window silently yields nothing.
 */
function lockup(title: string, videoId: string, padding: number): string {
  return `"lockupMetadataViewModel":{"title":{"content":"${title}"},"metadata":{"pad":"${'x'.repeat(padding)}"}},"contentId":"${videoId}"`;
}

describe('parseChannelVideosPage', () => {
  it('finds the newest video even when contentId is far from the title', () => {
    const html = `[${lockup('Eat Everything In A Grocery Store, Win $1,000,000', 'plN7JMbadRg', 5200)},${lockup('Second Video', 'CEJXqm2eiJ0', 5200)}]`;
    expect(parseChannelVideosPage(html, 'UCX6OQ3DkcsbYNE6H8uQQuVA')).toEqual({
      channelId: 'UCX6OQ3DkcsbYNE6H8uQQuVA',
      videoId: 'plN7JMbadRg',
      title: 'Eat Everything In A Grocery Store, Win $1,000,000',
      url: 'https://www.youtube.com/watch?v=plN7JMbadRg',
      thumbnail: 'https://i.ytimg.com/vi/plN7JMbadRg/hqdefault.jpg',
      published: '',
    });
  });

  it('decodes JSON escapes in the title', () => {
    const html = lockup('What\\u2019s Inside \\"My\\" Briefcase?', 'CEJXqm2eiJ0', 10);
    expect(parseChannelVideosPage(html, 'UC1')?.title).toBe('What\u2019s Inside "My" Briefcase?');
  });

  it('returns undefined when the page has no video lockups', () => {
    expect(parseChannelVideosPage('<html><body>consent</body></html>', 'UC1')).toBeUndefined();
  });
});
