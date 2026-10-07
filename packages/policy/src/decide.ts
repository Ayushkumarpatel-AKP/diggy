/**
 * The decision function.
 *
 * `decide(tool, args, context)` is the single gate every tool call passes
 * through. It returns `allow | confirm | deny` plus a human-readable reason and
 * (for `confirm`) a payload to show the user.
 *
 * Order of refusal, most severe first:
 *
 * 1. **unknown tool** → `deny` (no default-open).
 * 2. **sensitive site** → `deny` (banks / payments / password managers / health),
 *    unless the host is on the user's allow list.
 * 3. **irreversible** → at least `confirm`.
 * 4. **tainted + outward effect** → `confirm` (never `allow`).
 * 5. **injection-looking arguments + outward effect** → `confirm`.
 * 6. otherwise → `allow`.
 *
 * It never throws: garbage `tool`/`args`/`context` degrade to the safe branch.
 */
import { classifyTool, isOutwardEffect, normalizeToolName } from './classify';
import { sensitiveSiteCategory } from './sites';
import type { SensitiveCategory } from './sites';
import { isTainted } from './taint';
import { detectInjection, inspectableText } from './untrusted';
import { redactForModel } from './vault';
import type { ConfirmPayload, DecideResult, Decision, PolicyContext, ToolClass } from './types';

const RANK: Record<Decision, number> = { allow: 0, confirm: 1, deny: 2 };

function escalate(current: Decision, next: Decision): Decision {
  return RANK[next] > RANK[current] ? next : current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** URL-shaped argument keys a tool might target. */
const SITE_ARG_KEYS = ['url', 'href', 'pageUrl', 'link', 'target', 'site', 'domain'] as const;

/** Collect candidate URLs from the context and the arguments (never throws). */
function siteCandidates(context: PolicyContext, args: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') out.push(trimmed);
    }
  };
  push(context.url);
  if (isRecord(args)) {
    for (const key of SITE_ARG_KEYS) push(args[key]);
  }
  return out;
}

function titleFor(category: ToolClass): string {
  if (category === 'irreversible') return 'Confirm this irreversible action';
  if (category === 'write') return 'Confirm this action';
  return 'Confirmation required';
}

/**
 * Decide whether a tool call may run.
 *
 * @param tool tool name (any string; unknown names are denied).
 * @param args the arguments the model supplied (scanned for injection, previewed
 *   redacted for the confirmation UI).
 * @param context origin, taint and per-site allow list. Omit for the most
 *   conservative reading (the module taint store is still consulted).
 */
export function decide(tool: unknown, args?: unknown, context?: PolicyContext): DecideResult {
  const ctx: PolicyContext = isRecord(context) ? (context as PolicyContext) : {};
  const name = normalizeToolName(tool);
  const displayName = name === '' ? '(missing tool)' : name;

  let category: ToolClass = 'unknown';
  try {
    category = classifyTool(tool, args);
  } catch {
    category = 'unknown';
  }

  // 1. Unknown tool → deny. This is the "never default to allow" guarantee.
  if (category === 'unknown') {
    return {
      decision: 'deny',
      category,
      reason:
        `Refused: "${displayName}" is not in the known tool registry, and unknown tools ` +
        `are denied by default. Classify it in TOOL_CLASSIFICATION before it can run.`,
    };
  }

  // 2. Sensitive site → deny for reads AND actions (allow list wins).
  const allowlist = Array.isArray(ctx.siteAllowlist) ? ctx.siteAllowlist : undefined;
  const candidates = siteCandidates(ctx, args);
  const target = candidates[0] ?? null;
  let sensitive: SensitiveCategory | null = null;
  let sensitiveSite: string | null = null;
  for (const candidate of candidates) {
    const found = sensitiveSiteCategory(candidate, { allowlist });
    if (found) {
      sensitive = found;
      sensitiveSite = candidate;
      break;
    }
  }
  if (sensitive) {
    return {
      decision: 'deny',
      category,
      reason:
        `Refused: ${sensitiveSite} looks like a sensitive ${sensitive} site. Sensitive ` +
        `sites are blocked for reading and acting by default; add the host to your ` +
        `per-site allow list to override.`,
    };
  }

  // 3-5. Taint + injection + irreversibility.
  const injection = detectInjection(inspectableText(args));
  const contextInjection = detectInjection(inspectableText(ctx));
  const tainted = isTainted(ctx) || contextInjection.length > 0;
  const outward = isOutwardEffect(category);

  const reasons: string[] = [];
  if (tainted) {
    reasons.push(
      'untrusted content (web page, transcript, signed-in read or plugin result) is present in context',
    );
  }
  if (injection.length > 0) {
    reasons.push(
      `the arguments look like an injected instruction (${injection.map((h) => h.pattern).join(', ')})`,
    );
  }
  if (category === 'irreversible') {
    reasons.push('the action is irreversible');
  }

  let decision: Decision = 'allow';
  if (category === 'irreversible') decision = escalate(decision, 'confirm');
  if (outward && tainted) decision = escalate(decision, 'confirm');
  if (outward && injection.length > 0) decision = escalate(decision, 'confirm');

  if (decision === 'allow') {
    const note = reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
    return {
      decision,
      category,
      reason: `Allowed: "${displayName}" is a ${category} tool with no outward effect${note}.`,
    };
  }

  const confirmPayload: ConfirmPayload = {
    tool: displayName,
    category,
    title: titleFor(category),
    detail:
      `Diggy wants to run "${displayName}" (${category}). ` +
      `${reasons.join('; ')}. Confirm before it happens.`,
    reasons,
    site: target,
    preview: redactForModel(args),
  };

  return {
    decision,
    category,
    reason: `Confirmation required for "${displayName}": ${reasons.join('; ')}.`,
    confirmPayload,
  };
}
