/**
 * The policy bridge.
 *
 * Every act-layer action is mapped onto a `@diggy/policy` tool name and run
 * through `decide()`. The policy layer — not this package — owns the rules;
 * this module only translates an action into the vocabulary `decide` speaks and
 * turns its verdict into an {@link ActionResult}.
 *
 * The mapping is intentionally conservative:
 *
 * | action | tool | class |
 * |---|---|---|
 * | `click` (normal) | `fillForm` | write |
 * | `click` (submit/send/delete/purchase) | `submit` | irreversible |
 * | `type`, `select` | `fillForm` | write |
 * | `pressKey` (`Enter` in a form) | `submit` | irreversible |
 * | `pressKey` (any other key) | `fillForm` | write |
 * | `scroll`, `waitFor` | `readPage` | read |
 * | `navigate`, `goBack` | `readPage` | read |
 *
 * Because `write`/`irreversible` are outward effects, a tainted session escalates
 * them to `confirm` without this package knowing anything about taint. Reads such
 * as `navigate` carry their target URL, so a sensitive site (bank, payment,
 * password manager) is refused by `decide`'s site check.
 */
import { decide } from '@diggy/policy';
import type { ConfirmPayload, PolicyContext, ToolClass } from '@diggy/policy';
import type { ActionResult } from './types';

/** The eight actions the act layer exposes. */
export type PageActionKind =
  | 'click'
  | 'type'
  | 'select'
  | 'pressKey'
  | 'scroll'
  | 'waitFor'
  | 'navigate'
  | 'goBack';

/** The default policy tool name per action (submit-key variants override `click`/`pressKey`). */
export const ACTION_TOOL: Readonly<Record<PageActionKind, string>> = {
  click: 'fillForm',
  type: 'fillForm',
  select: 'fillForm',
  pressKey: 'fillForm',
  scroll: 'readPage',
  waitFor: 'readPage',
  navigate: 'readPage',
  goBack: 'readPage',
};

/** The policy tool used for anything that would submit/send/delete/purchase. */
export const SUBMIT_TOOL = 'submit';

/** The outcome of a policy check. */
export type GateOutcome =
  | { allowed: true; category: ToolClass }
  | { allowed: false; category: ToolClass; blocked: ActionResult };

export interface GateInput {
  tool: string;
  args: unknown;
  context: PolicyContext;
  /** The user already approved this call (host-supplied). */
  approved: boolean;
  /** A phrase describing the attempted action, used in the summary. */
  summary: string;
}

/**
 * Ask the policy layer whether an action may run.
 *
 * - `deny` → blocked, always.
 * - `confirm` → blocked **unless** `approved` is set.
 * - `allow` → runs.
 */
export function evaluateGate(input: GateInput): GateOutcome {
  const result = decide(input.tool, input.args, input.context);

  if (result.decision === 'deny') {
    return {
      allowed: false,
      category: result.category,
      blocked: {
        ok: false,
        decision: 'deny',
        summary: `${input.summary} — refused by policy.`,
        error: result.reason,
      },
    };
  }

  if (result.decision === 'confirm' && !input.approved) {
    const blocked: ActionResult = {
      ok: false,
      decision: 'confirm',
      summary: `${input.summary} — needs confirmation first.`,
      error: result.reason,
    };
    if (result.confirmPayload) blocked.confirm = result.confirmPayload;
    return { allowed: false, category: result.category, blocked };
  }

  return { allowed: true, category: result.category };
}

/**
 * Build the `confirm` result for a control the act layer will never operate
 * itself (a submit/send/delete/purchase control). Even with `approved: true`
 * the action is not executed — the rule is that a submit is the user's to press.
 */
export function submitRefusal(
  args: unknown,
  context: PolicyContext,
  summary: string,
): ActionResult {
  const result = decide(SUBMIT_TOOL, args, context);
  const denied = result.decision === 'deny';

  const refusal: ActionResult = {
    ok: false,
    decision: denied ? 'deny' : 'confirm',
    summary,
    error: denied
      ? result.reason
      : 'Diggy never submits, sends, deletes or purchases on its own. Show the user the confirmation and let them press it.',
  };
  if (result.confirmPayload) refusal.confirm = result.confirmPayload as ConfirmPayload;
  return refusal;
}
