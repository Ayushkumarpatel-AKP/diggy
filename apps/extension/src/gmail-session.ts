/**
 * Zero-setup Gmail access.
 *
 * Instead of OAuth, this uses the browser's *existing* Gmail session: the
 * extension has `<all_urls>` host permission, so it can fetch Google's public
 * Gmail Atom feed with the user's cookies (`credentials: 'include'`). If the
 * user is signed in to Gmail in this browser, it just works — no Cloud Console,
 * no client ID, no redirect URI.
 *
 * Trade-off: the feed only exposes the most recent inbox messages (which is
 * exactly what a "new mail" watcher needs). OAuth is still available for the
 * full API (search, history).
 */
export interface SessionMail {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

export interface InboxFeed {
  /** Unread count reported by the feed. */
  count: number;
  messages: SessionMail[];
}

/** Which signed-in Google account to read (0 = the first). */
export function gmailFeedUrl(account = 0): string {
  return `https://mail.google.com/mail/u/${Math.max(0, account)}/feed/atom`;
}

function unescapeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block: string, name: string): string {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return match ? match[1] : '';
}

/** Parse Google's Gmail Atom feed into structured messages. */
export function parseInboxFeed(xml: string): InboxFeed {
  const count = Number(/<fullcount>\s*(\d+)\s*<\/fullcount>/i.exec(xml)?.[1] ?? '0') || 0;
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
  const messages: SessionMail[] = entries.map((entry, index) => {
    const author = /<author>([\s\S]*?)<\/author>/i.exec(entry)?.[1] ?? '';
    const name = unescapeXml(tag(author, 'name'));
    const email = unescapeXml(tag(author, 'email'));
    return {
      id: unescapeXml(tag(entry, 'id')) || `atom-${index}`,
      subject: unescapeXml(tag(entry, 'title')) || '(no subject)',
      snippet: unescapeXml(tag(entry, 'summary')),
      from: name || email || 'Gmail',
      date: tag(entry, 'issued') || tag(entry, 'modified'),
    };
  });
  return { count, messages };
}

/** Fetch the signed-in inbox (throws a friendly error when not signed in). */
export async function fetchInboxFeed(account = 0): Promise<InboxFeed> {
  const response = await fetch(gmailFeedUrl(account), {
    credentials: 'include',
    headers: { accept: 'application/atom+xml,application/xml,text/xml' },
  });
  if (response.status === 401 || response.status === 403 || response.redirected) {
    throw new Error('Not signed in to Gmail in this browser — sign in at mail.google.com and retry.');
  }
  if (!response.ok) {
    throw new Error(`Gmail feed returned ${response.status}. Sign in to Gmail in this browser first.`);
  }
  const xml = await response.text();
  if (!/<feed/i.test(xml)) {
    throw new Error('Gmail did not return a feed — are you signed in?');
  }
  return parseInboxFeed(xml);
}
