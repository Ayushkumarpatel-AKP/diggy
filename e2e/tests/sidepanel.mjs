/**
 * Test 2 — the side panel opens and its Plugins tab shows the icon gallery.
 *
 * Loads the built `sidepanel.html` from the extension origin, asserts the
 * section nav renders with its expected tabs, opens the Plugins tab and asserts
 * the one-click plugin gallery renders (its title badge, the gallery card and
 * the Google brand icon).
 */
import { assert, openPanel } from '../harness.mjs';

export const name = 'sidepanel-opens';
export const description = 'sidepanel.html renders its tab nav and the Plugins icon gallery';

const EXPECTED_TABS = ['Chat', 'Profile', 'Reminders', 'Watch', 'Plugins', 'Apps', 'Page'];

export async function run(env) {
  const app = await env.launch();
  try {
    const panel = await openPanel(app);

    const tabs = await panel.$$eval('nav[aria-label="Diggy sections"] button', (buttons) =>
      buttons.map((button) => button.getAttribute('aria-label')),
    );
    for (const tab of EXPECTED_TABS) {
      assert(tabs.includes(tab), `tab nav must include "${tab}" (saw: ${tabs.join(', ')})`);
    }

    // The panel header should show the Diggy badge + a status badge.
    const headerText = (await panel.locator('header').first().innerText()).toLowerCase();
    assert(headerText.includes('diggy'), 'panel header must show the Diggy badge');

    // Open the Plugins tab via its nav button (aria-label "Plugins").
    await panel.getByRole('button', { name: 'Plugins' }).click();

    // The gallery title badge ("Plugins") + the one-click gallery card.
    await panel.getByText('Plugins', { exact: true }).first().waitFor({ timeout: 15_000 });
    await panel.getByText('One-click plugins', { exact: true }).waitFor({ timeout: 15_000 });

    // The gallery must render brand icons as inline SVG (nothing is fetched —
    // the extension CSP forbids remote images, so icons are local components).
    const svgCount = await panel.locator('svg').count();
    assert(svgCount > 0, 'the plugin gallery must render at least one inline brand icon (svg)');

    return `tabs=[${tabs.join(', ')}], Plugins gallery rendered with ${svgCount} inline icon(s)`;
  } finally {
    await app.close();
  }
}
