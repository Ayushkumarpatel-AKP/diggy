/**
 * @diggy/policy — the agent security policy layer.
 *
 * A dependency-free gate that sits between the model and the tool executors:
 *
 * - {@link classifyTool} — every tool is `read | write | irreversible`; unknown
 *   tools are `unknown` and denied, never allowed.
 * - {@link decide} — `allow | confirm | deny` from the tool, its args, and a
 *   {@link PolicyContext} (origin, taint, per-site allow list).
 * - {@link markUntrusted} / {@link isTainted} / {@link resetTaint} — taint
 *   tracking: once untrusted content is in context, outward effects must confirm.
 * - {@link wrapUntrusted} / {@link buildUntrustedGuard} — fence untrusted text as
 *   DATA and teach the model the convention.
 * - {@link isSensitiveSite} — default-deny for banks, payments, password
 *   managers and health portals, with a user-configurable per-site allow list.
 * - {@link summarizeUntrusted} — the quarantined-reader contract for signed-in
 *   page reads.
 * - {@link redactForModel} / {@link VAULT_SENTINEL} — keep vault values out of
 *   model messages.
 *
 * No DOM, no `chrome`, no third-party imports; nothing throws on garbage input.
 */
export * from './types';
export * from './classify';
export * from './taint';
export * from './sites';
export * from './untrusted';
export * from './decide';
export * from './quarantine';
export * from './vault';
