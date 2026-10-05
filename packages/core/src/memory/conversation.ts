/**
 * Rolling-window conversation buffer.
 *
 * In-memory only: the host owns persistence (the desktop vault is the source of
 * truth). The buffer keeps the last N messages under a character budget so the
 * prompt stays inside the model's context window.
 */
import type { CoreMessage, CoreUserMessage, CoreAssistantMessage, CoreSystemMessage } from 'ai';

export interface ConversationOptions {
  /** Hard cap on stored (non-system) messages. Default 40. */
  maxMessages?: number;
  /** Soft cap on total characters across stored messages. Default 24000. */
  maxChars?: number;
  /** Optional system prompt kept alongside the window. */
  system?: string;
}

export class ConversationBuffer {
  private readonly store: CoreMessage[] = [];
  private readonly maxMessages: number;
  private readonly maxChars: number;
  private system: string | undefined;

  constructor(options: ConversationOptions = {}) {
    this.maxMessages = options.maxMessages ?? 40;
    this.maxChars = options.maxChars ?? 24000;
    this.system = options.system;
  }

  /** Number of messages currently held (excludes the system prompt). */
  get size(): number {
    return this.store.length;
  }

  getSystem(): string | undefined {
    return this.system;
  }

  setSystem(system: string | undefined): void {
    this.system = system;
  }

  /** Append a message and trim the window back to budget. */
  add(message: CoreMessage): void {
    this.store.push(message);
    this.trim();
  }

  addUser(content: string): void {
    const message: CoreUserMessage = { role: 'user', content };
    this.add(message);
  }

  addAssistant(content: string): void {
    const message: CoreAssistantMessage = { role: 'assistant', content };
    this.add(message);
  }

  addSystem(content: string): void {
    this.system = content;
  }

  /** Snapshot of the current window (without the system prompt). */
  messages(): CoreMessage[] {
    return [...this.store];
  }

  /** Snapshot including the system prompt (if set), ready for `runAgent`. */
  toPrompt(): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    if (this.system) {
      const systemMessage: CoreSystemMessage = { role: 'system', content: this.system };
      msgs.push(systemMessage);
    }
    msgs.push(...this.store);
    return msgs;
  }

  clear(): void {
    this.store.length = 0;
  }

  /** Reset everything, including the system prompt. */
  reset(): void {
    this.clear();
    this.system = undefined;
  }

  private trim(): void {
    while (
      this.store.length > this.maxMessages ||
      this.charCount() > this.maxChars
    ) {
      if (this.store.length <= 1) break; // never drop the only remaining message
      this.store.shift();
    }
  }

  private charCount(): number {
    let total = 0;
    for (const message of this.store) {
      total += estimateChars(message);
    }
    return total;
  }
}

/** Best-effort character estimate for a core message. */
export function estimateChars(message: CoreMessage): number {
  if (typeof message.content === 'string') return message.content.length;
  return message.content.reduce((sum, part) => {
    if (part.type === 'text') return sum + part.text.length;
    if (part.type === 'tool-result') return sum + JSON.stringify(part.result).length;
    return sum + 32;
  }, 0);
}
