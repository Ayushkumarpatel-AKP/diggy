/**
 * SPIKE — NOT SHIPPED.
 *
 * How a **remote MCP server** could stand in for the hand-written plugin
 * connectors. The two files this mirrors are:
 *
 *   - `services/api/src/providers.ts` — the static `PROVIDERS` registry the
 *     backend serves from `GET /plugins`, and
 *   - `services/api/src/routes/actions.ts` — the `POST /actions/:provider/:action`
 *     switch that hard-codes each provider call.
 *
 * With MCP a server *advertises* its own tools (`tools/list`), so the registry
 * and the action switch become data instead of code. The helper below turns an
 * MCP tool list back into the exact row shape `PluginsPanel.tsx` renders today.
 */
import type { Tool } from 'ai';

/* ------------------------------------------------------------------ *
 * The current model (mirrored, for the side-by-side in the README)
 * ------------------------------------------------------------------ */

export type ProviderAuthKind = 'oauth2' | 'none';

/** Mirrors `services/api/src/providers.ts` (`PROVIDERS`). */
export const CURRENT_REGISTRY: readonly {
  id: string;
  name: string;
  auth: ProviderAuthKind;
  actions: readonly string[];
}[] = [
  { id: 'google', name: 'Google', auth: 'oauth2', actions: ['gmail.list', 'calendar.list', 'calendar.create'] },
  { id: 'notion', name: 'Notion', auth: 'oauth2', actions: ['search', 'createPage'] },
  { id: 'github', name: 'GitHub', auth: 'oauth2', actions: ['me', 'listRepos', 'createIssue'] },
  { id: 'youtube', name: 'YouTube', auth: 'none', actions: ['latest'] },
];

/** The row shape `GET /plugins` returns and `PluginsPanel.tsx` renders. */
export interface GalleryRow {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  auth: ProviderAuthKind;
  connected: boolean;
  accountLabel?: string;
}

export interface McpToolLike {
  name: string;
  description?: string;
}

/* ------------------------------------------------------------------ *
 * Tool-name <-> (provider, action) mapping
 * ------------------------------------------------------------------ */

/**
 * MCP tool names are `[a-zA-Z0-9_-.]`, so `provider.action` is legal — but the
 * local action ids *already* contain dots (`google/gmail.list`), so the flat
 * form collides. Use `provider.action` only when the provider set is known (as
 * it is today); otherwise prefer a two-part separator. Both are shown here.
 */
export function mcpToolName(provider: string, action: string): string {
  return `${provider}.${action}`;
}

/**
 * Split an MCP tool name into the provider/action pair the local backend routes
 * on. Known provider ids are matched longest-first so `google.gmail.list`
 * resolves to `{ provider: 'google', action: 'gmail.list' }`.
 */
export function parseMcpToolName(
  toolName: string,
  providerIds: readonly string[] = CURRENT_REGISTRY.map((p) => p.id),
): { provider: string; action: string } | null {
  const ordered = [...providerIds].sort((a, b) => b.length - a.length);
  for (const provider of ordered) {
    if (toolName === provider) return { provider, action: '' };
    if (toolName.startsWith(`${provider}.`) || toolName.startsWith(`${provider}/`)) {
      const action = toolName.slice(provider.length + 1);
      if (action.length > 0) return { provider, action };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Deriving the registry + gallery rows from an MCP server
 * ------------------------------------------------------------------ */

/**
 * Rebuild the `PROVIDERS` shape from an MCP server's advertised tools. Every
 * distinct name prefix becomes a provider; its tools become the actions. On a
 * real server you would read `serverInfo`/`icons` from the `initialize` result
 * — the AI SDK client keeps those private, so this spike has only the tools.
 */
export function registryFromMcpTools(
  tools: readonly McpToolLike[],
  providerIds: readonly string[] = CURRENT_REGISTRY.map((p) => p.id),
): { id: string; actions: string[] }[] {
  const byProvider = new Map<string, string[]>();
  for (const tool of tools) {
    const parsed = parseMcpToolName(tool.name, providerIds);
    if (!parsed) continue;
    const list = byProvider.get(parsed.provider) ?? [];
    list.push(parsed.action);
    byProvider.set(parsed.provider, list);
  }
  return [...byProvider.entries()].map(([id, actions]) => ({ id, actions: actions.sort() }));
}

/**
 * The `ApiPlugin[]` rows the gallery would show for an MCP server. `connected`
 * and `accountLabel` are **transport/consent concepts MCP does not define** —
 * they stay `false`/undefined here, which is exactly the gap called out in the
 * write-up: MCP describes *capabilities*, not *who authorised them*.
 */
export function galleryRowsFromMcpServer(
  serverName: string,
  tools: readonly McpToolLike[],
  providerIds: readonly string[] = CURRENT_REGISTRY.map((p) => p.id),
): GalleryRow[] {
  const derived = registryFromMcpTools(tools, providerIds);
  return derived.map((entry) => {
    const known = CURRENT_REGISTRY.find((p) => p.id === entry.id);
    return {
      id: entry.id,
      name: known?.name ?? entry.id,
      description: `${entry.actions.length} tool${entry.actions.length === 1 ? '' : 's'} from MCP server “${serverName}”`,
      icon: entry.id,
      auth: known?.auth ?? 'oauth2',
      connected: false,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Merging MCP tools into the built-in toolset
 * ------------------------------------------------------------------ */

/**
 * Merge an MCP toolset into the built-in one (the analogue of
 * `assertCompleteToolset` in `packages/core/src/tools/index.ts`). Collisions are
 * fatal rather than silently overwritten — a remote server must not be able to
 * shadow `readPage`, `readInbox`, `fillForm`, … .
 */
export function mergeToolsets(
  base: Readonly<Record<string, Tool>>,
  fromMcp: Readonly<Record<string, Tool>>,
): Record<string, Tool> {
  const collisions = Object.keys(fromMcp).filter((name) => name in base);
  if (collisions.length > 0) {
    throw new Error(`MCP tool(s) collide with built-in tools: ${collisions.join(', ')}`);
  }
  return { ...base, ...fromMcp };
}
