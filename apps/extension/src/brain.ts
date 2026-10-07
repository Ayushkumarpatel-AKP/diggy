/**
 * Resilient brain runner with automatic provider failover.
 *
 * When the active provider hits a limit (HTTP 429 / quota), Diggy immediately
 * retries with the other configured provider so the conversation keeps going,
 * and remembers that the provider is exhausted for a while so later turns go
 * straight to the working one.
 */
import { createProvider, errorDetail, friendlyError, runAgent } from '@diggy/core';
import type { ToolContext } from '@diggy/core';
import type { Settings } from './storage';

type Messages = Parameters<typeof runAgent>[0]['messages'];
export type ProviderName = 'groq' | 'nvidia';

/** How long an exhausted provider is skipped before we try it again. */
const EXHAUST_MS = 5 * 60 * 1000;

const exhaustedUntil: Partial<Record<ProviderName, number>> = {};

function keyFor(settings: Settings, name: ProviderName): string {
  return (name === 'groq' ? settings.groqKey : settings.nvidiaKey)?.trim() ?? '';
}

/** Providers that have a key, active first, then the other. */
export function providerChain(settings: Settings): ProviderName[] {
  const first: ProviderName = settings.provider === 'nvidia' ? 'nvidia' : 'groq';
  const second: ProviderName = first === 'groq' ? 'nvidia' : 'groq';
  return [first, second].filter((name) => keyFor(settings, name).length > 0);
}

/** Does this error look like a rate limit / quota / billing problem? */
export function isQuotaError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /rate limit|429|quota|exceeded|too many requests|tokens per minute|\btpm\b|billing|insufficient/.test(
    text,
  );
}

export function isExhausted(name: ProviderName): boolean {
  const until = exhaustedUntil[name];
  return Boolean(until && until > Date.now());
}

function markExhausted(name: ProviderName): void {
  exhaustedUntil[name] = Date.now() + EXHAUST_MS;
}

/** Reset the exhaustion memory (e.g. after the user changes keys). */
export function resetProviderHealth(): void {
  for (const name of Object.keys(exhaustedUntil) as ProviderName[]) delete exhaustedUntil[name];
}

export interface ResilientResult {
  text: string;
  provider: ProviderName;
  ok: boolean;
  error?: string;
  context: ToolContext;
  /** True when a provider was skipped/switched during this run. */
  switched: boolean;
}

export interface ResilientOptions {
  settings: Settings;
  messages: Messages;
  /** A fresh tool context per attempt (some carry per-run state). */
  makeContext: () => ToolContext;
  onDelta?: (delta: string, full: string) => void;
}

/**
 * Run one agent turn, trying each configured provider until one answers.
 */
export async function runResilient(options: ResilientOptions): Promise<ResilientResult> {
  const chain = providerChain(options.settings);
  let context = options.makeContext();

  if (chain.length === 0) {
    return {
      text: 'I don’t have a brain configured yet — add a Groq or NVIDIA API key in ⚙ settings.',
      provider: options.settings.provider,
      ok: false,
      error: 'no-key',
      context,
      switched: false,
    };
  }

  // Prefer providers that are not currently exhausted, but keep them as a last resort.
  const ordered = [...chain].sort((a, b) => Number(isExhausted(a)) - Number(isExhausted(b)));

  let lastError = '';
  let switched = false;

  for (const name of ordered) {
    const apiKey = keyFor(options.settings, name);
    if (!apiKey) continue;
    let model;
    try {
      model = createProvider({ name, apiKey, model: options.settings.model?.trim() || undefined });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }

    // A reasoning model occasionally ends a turn with no visible text (all of
    // it went into reasoning, or a tool round finished silently). One nudge
    // usually gets a real answer instead of an empty reply.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      context = options.makeContext();
      let full = '';
      const messages =
        attempt === 0
          ? options.messages
          : [
              ...options.messages,
              { role: 'user' as const, content: 'Reply now with one short sentence.' },
            ];
      try {
        const result = runAgent({ messages, provider: model, context });
        for await (const delta of result.textStream) {
          full += delta;
          options.onDelta?.(delta, full);
        }
        if (!full.trim()) {
          // The AI SDK ends the stream silently on an error part; surface it.
          try {
            full = await result.text;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isQuotaError(message)) markExhausted(name);
            lastError = message;
            break;
          }
        }
        if (full.trim()) {
          return { text: full.trim(), provider: name, ok: true, context, switched };
        }
        lastError = 'The model returned an empty reply.';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isQuotaError(message)) markExhausted(name);
        lastError = message;
        break;
      }
    }
    switched = true;
  }

  return {
    // Never show the raw provider payload — say what happened in one line.
    text: friendlyError(lastError || 'The model did not respond.', {
      provider: options.settings.provider,
      switched,
    }),
    provider: options.settings.provider,
    ok: false,
    error: errorDetail(lastError),
    context,
    switched,
  };
}
