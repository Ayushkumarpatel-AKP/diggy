/**
 * Copies the VRM avatar into the apps that serve it.
 *
 * The 17 MB model lives once in `assets/avatar/`. This runs on `pnpm install`
 * (root `postinstall`) so a fresh clone has it in `apps/demo/public` and
 * `apps/extension/public` without committing three copies of the same file.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'assets', 'avatar', 'AvatarSample_I.vrm');
const targets = [
  join(root, 'apps', 'demo', 'public', 'AvatarSample_I.vrm'),
  join(root, 'apps', 'extension', 'public', 'AvatarSample_I.vrm'),
];

if (!existsSync(source)) {
  console.warn('[diggy] assets/avatar/AvatarSample_I.vrm is missing — skipping avatar sync.');
  process.exit(0);
}

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`[diggy] avatar synced -> ${target.slice(root.length + 1)}`);
}
