/**
 * Test 4 — a reminder fires.
 *
 * The side panel's datetime input is minute-granular, so a ~3s reminder cannot
 * be typed through the UI. Instead we create it through *exactly* the panel's
 * own path: write it to `chrome.storage.local['diggy:reminders']` and send
 * `diggy:reminder-schedule` (the same message the RemindersPanel sends).
 *
 * We then assert, in the active fixture tab:
 *   - the in-page bubble received the "fired" line (PRIMARY assertion), and
 *   - if the browser created one, a notification with the reminder title
 *     (checked headlessly via chrome.notifications.getAll()).
 * Finally we assert the reminder flipped to status "done" in storage.
 */
import { assert, assertEqual, openBotPage, openPanel, waitForBubbleText } from '../harness.mjs';

export const name = 'reminder-fires';
export const description = 'a ~3s reminder fires into the in-page bubble (and notification if available)';

const TITLE = 'E2E reminder';
const REMINDER_ID = 'e2e-reminder-1';

export async function run(env) {
  const app = await env.launch();
  try {
    const panel = await openPanel(app);
    const fixture = await openBotPage(app, env.fixtures.fixtureUrl('simple-page'));
    await fixture.bringToFront();

    const dueAt = new Date(Date.now() + 3000).toISOString();
    await panel.evaluate(
      async ({ reminder, key }) => {
        const stored = await chrome.storage.local.get(key);
        const list = Array.isArray(stored[key]) ? stored[key] : [];
        await chrome.storage.local.set({ [key]: [...list.filter((r) => r.id !== reminder.id), reminder] });
        await chrome.runtime.sendMessage({ type: 'diggy:reminder-schedule', reminder });
      },
      {
        key: 'diggy:reminders',
        reminder: {
          id: REMINDER_ID,
          title: TITLE,
          notes: 'fired by the e2e suite',
          dueAt,
          status: 'pending',
          createdAt: new Date().toISOString(),
          source: 'e2e',
        },
      },
    );

    const started = Date.now();
    // PRIMARY: the in-page bubble shows the fired line.
    const state = await waitForBubbleText(fixture, new RegExp(`⏰\\s*${TITLE}`), 75_000);
    const elapsed = Date.now() - started;
    assert(state.sayText.includes(TITLE), `bubble must mention "${TITLE}" (saw: ${state.sayText})`);

    // SECONDARY: a native notification, observable headlessly via the API.
    let notification = null;
    try {
      const notes = await panel.evaluate(async () => {
        const all = await chrome.notifications.getAll();
        return Object.values(all).map((n) => ({ title: n.title, message: n.message }));
      });
      notification = notes.find((n) => (n.title || '').includes(TITLE)) ?? null;
    } catch {
      notification = null;
    }

    // The reminder must be marked done once it has rung.
    const status = await panel.evaluate(async (key) => {
      const stored = await chrome.storage.local.get(key);
      const found = (stored[key] || []).find((r) => r.id === 'e2e-reminder-1');
      return found ? found.status : null;
    }, 'diggy:reminders');
    assertEqual(status, 'done', 'reminder status after firing');

    const note = notification
      ? `notification asserted: "${notification.title}" (${notification.message})`
      : 'notification NOT observable headlessly — asserted the in-page bubble line instead';
    return `bubble line after ${elapsed}ms; reminder status=done; ${note}`;
  } finally {
    await app.close();
  }
}
