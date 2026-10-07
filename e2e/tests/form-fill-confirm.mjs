/**
 * Test 3 — the form-fill confirm flow.
 *
 * Exercises the *real* panel path end to end:
 *   1. seed the local profile cache (what the vault would decrypt),
 *   2. click the panel's "Fill form" quick action → Diggy scans the page and
 *      shows a "Confirm fill" plan,
 *   3. click "Fill" → the plan is applied through
 *      panel → background → content script `fillForm`,
 *   4. assert the page's inputs gained values and the fixture recorded
 *      **zero** submit events.
 */
import { assert, assertEqual, openBotPage, openPanel } from '../harness.mjs';

export const name = 'form-fill-confirm';
export const description = 'panel "Fill form" → confirm plan → inputs filled, form NOT submitted';

const PROFILE = {
  identity: {
    fullName: 'Ayush Sharma',
    firstName: 'Ayush',
    lastName: 'Sharma',
    email: 'ayush.sharma@example.com',
    phone: '+91 90000 00000',
    links: {},
  },
  education: [],
  experience: [],
  skills: [],
  projects: [],
  documents: {},
  customAnswers: [],
  preferences: {},
  secrets: {},
};

export async function run(env) {
  const app = await env.launch();
  try {
    const panel = await openPanel(app);
    const form = await openBotPage(app, env.fixtures.fixtureUrl('form'));
    // The panel targets the *active* tab, so the form page must be in front.
    await form.bringToFront();

    // 1. Seed the profile the panel maps fields from.
    await panel.evaluate(async (profile) => {
      await chrome.storage.local.set({ 'diggy:profile': profile });
    }, PROFILE);

    // 2. Scan + plan (deterministic, offline heuristic mapping).
    await panel.getByRole('button', { name: 'Fill form' }).click();
    await panel.getByText('Confirm fill').waitFor({ timeout: 20_000 });
    const fieldCount = await panel.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('span')).find(
        (node) => /field\(s\)$/.test((node.textContent || '').trim()),
      );
      return heading ? heading.textContent.trim() : null;
    });
    assert(fieldCount, 'the confirm card must report how many fields it will fill');
    assert(/[1-9]/.test(fieldCount), `confirm card reported no fields: ${fieldCount}`);

    // 3. Confirm → apply the plan.
    await panel.getByRole('button', { name: 'Fill', exact: true }).click();
    await panel.getByText(/Filled \d+ field\(s\)\. Nothing was submitted/).first().waitFor({ timeout: 20_000 });

    // 4. Assert the page state.
    const filled = await form.evaluate(() => ({
      fullName: document.getElementById('fullName').value,
      email: document.getElementById('email').value,
      phone: document.getElementById('phone').value,
      why: document.getElementById('why').value,
      submitted: window.__diggySubmitted,
      submitCount: window.__diggySubmitCount,
    }));

    assertEqual(filled.fullName, PROFILE.identity.fullName, 'fullName input');
    assertEqual(filled.email, PROFILE.identity.email, 'email input');
    assertEqual(filled.phone, PROFILE.identity.phone, 'phone input');
    assertEqual(filled.why, '', 'unmapped field must stay empty');
    assert(filled.submitted !== true, 'the fixture must NOT have been submitted');
    assertEqual(filled.submitCount, 0, 'fixture submit-event count');

    return `plan="${fieldCount}", filled fullName/email/phone, submitCount=${filled.submitCount}`;
  } finally {
    await app.close();
  }
}
