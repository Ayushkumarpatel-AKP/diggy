/**
 * Zero-setup Calendar access via the calendar's "Secret address in iCal format".
 *
 * The user copies that URL once from Google Calendar → Settings → (their
 * calendar) → "Secret address in iCal format" and pastes it into the Apps tab.
 * No OAuth, no Cloud Console. We fetch and parse the ICS feed.
 */
export interface IcsEvent {
  id: string;
  summary: string;
  start: string;
  end?: string;
  location?: string;
  allDay?: boolean;
}

/** Unfold ICS lines (continuations start with a space or tab). */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseIcsDate(value: string): { date: Date; allDay: boolean } | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    return {
      date: new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])),
      allDay: true,
    };
  }
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!stamp) return null;
  const [, y, mo, d, h, mi, s, z] = stamp;
  const date =
    z === 'Z'
      ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
      : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { date, allDay: false };
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function property(block: string, name: string): string | undefined {
  const match = new RegExp(`^${name}(?:;[^:]*)?:([\\s\\S]*)$`, 'im').exec(block);
  return match ? match[1] : undefined;
}

/** Parse an ICS document into upcoming events (window = now ± days). */
export function parseIcs(ics: string, options: { days?: number; max?: number } = {}): IcsEvent[] {
  const days = Math.min(Math.max(options.days ?? 7, 1), 60);
  const max = Math.min(Math.max(options.max ?? 15, 1), 50);
  const from = Date.now() - 6 * 3600_000;
  const to = Date.now() + days * 86_400_000;

  const lines = unfold(ics);
  const events: IcsEvent[] = [];
  let block: string[] | null = null;

  const flush = (): void => {
    if (!block) return;
    const text = block.join('\n');
    const startRaw = property(text, 'DTSTART');
    if (startRaw) {
      const parsed = parseIcsDate(startRaw.trim());
      if (parsed && parsed.date.getTime() >= from && parsed.date.getTime() <= to) {
        const endRaw = property(text, 'DTEND');
        const end = endRaw ? parseIcsDate(endRaw.trim()) : null;
        events.push({
          id: unescapeIcs(property(text, 'UID') ?? `${startRaw}-${events.length}`),
          summary: unescapeIcs(property(text, 'SUMMARY') ?? '(no title)') || '(no title)',
          location: property(text, 'LOCATION') ? unescapeIcs(property(text, 'LOCATION') as string) : undefined,
          start: parsed.date.toISOString(),
          end: end?.date.toISOString(),
          allDay: parsed.allDay,
        });
      }
    }
    block = null;
  };

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) block = [];
    else if (line.startsWith('END:VEVENT')) flush();
    else if (block) block.push(line);
  }

  return events.sort((a, b) => a.start.localeCompare(b.start)).slice(0, max);
}

/** Fetch and parse a calendar's ICS feed. */
export async function fetchIcsEvents(
  url: string,
  options: { days?: number; max?: number } = {},
): Promise<IcsEvent[]> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Paste the calendar’s "Secret address in iCal format" URL (https…).');
  }
  const response = await fetch(trimmed, { credentials: 'include' });
  if (!response.ok) throw new Error(`Calendar feed returned ${response.status}. Check the ICS URL.`);
  return parseIcs(await response.text(), options);
}
