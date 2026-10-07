/**
 * SPIKE — NOT SHIPPED.
 *
 * Borrows the AI SDK that `@diggy/core` already depends on (`ai@4.3.19`) so this
 * spike adds **no** dependency and joins **no** workspace package.
 *
 * `src/tsconfig.json` maps the bare `"ai"` specifier to the installed copy under
 * `packages/core/node_modules/ai` for the *type checker*. At *runtime* we load
 * the very same copy with `createRequire`, because a directory outside the pnpm
 * workspace cannot resolve a hoisted `ai` on its own. `typeof import('ai')` is a
 * type-only reference, so Node's type stripping erases it and the only real
 * module load is the explicit `require('ai')` below.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** <repo>/packages/core/package.json — the anchor for resolving `ai`. */
const corePackageJson = resolve(here, '..', '..', '..', 'packages', 'core', 'package.json');

const coreRequire = createRequire(corePackageJson);

/** The real AI SDK module, loaded from the copy `@diggy/core` already has. */
export const ai = coreRequire('ai') as typeof import('ai');

/** Absolute path the resolution landed on (handy for the smoke transcript). */
export const aiModulePath: string = coreRequire.resolve('ai');

/**
 * The MCP client class is not exported by name in `ai@4.3.19`, so we derive the
 * type from the factory instead of importing `MCPClient` directly.
 */
export type McpClient = Awaited<ReturnType<typeof ai.experimental_createMCPClient>>;
