/**
 * The Diggy toolset exposed to the LLM.
 *
 * Each tool's zod schema mirrors the corresponding `@diggy/shared`
 * `MethodParams[name]`, and its `execute` simply delegates to the injected
 * {@link ToolContext}. That means the model can *request* an action but the host
 * decides how (and whether) it actually happens — see `src/prompt.ts` for the
 * confirm-before-destructive / never-auto-submit rules baked into the persona.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { AvatarMood, AvatarState, Profile, ToolName } from '@diggy/shared';
import { TOOL_NAMES, type ToolContext } from './types';

const PROFILE_SECTIONS = [
  'identity',
  'education',
  'experience',
  'skills',
  'projects',
  'certifications',
  'documents',
  'customAnswers',
  'preferences',
  'secrets',
] as const satisfies readonly (keyof Profile)[];

const MOODS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'relaxed',
  'surprised',
  'thinking',
] as const satisfies readonly AvatarMood[];

const AVATAR_STATES = [
  'idle',
  'enter',
  'exit',
  'talk',
  'listen',
  'think',
  'celebrate',
  'sad',
] as const satisfies readonly AvatarState[];

const fillInstructionSchema = z.object({
  fieldId: z.string().describe('DOM id/handle of the field to fill'),
  value: z.string().describe('Value to type into the field'),
  confidence: z.number().min(0).max(1).optional().describe('Mapping confidence 0..1'),
  profilePath: z.string().optional().describe('Vault profile path this value came from'),
});

export type Toolset = Record<ToolName, Tool>;

/**
 * Build the full toolset bound to a {@link ToolContext}.
 * Every `ToolName` from `@diggy/shared` is present.
 */
export function buildToolset(context: ToolContext): Toolset {
  const tools: Toolset = {
    readPage: tool({
      description:
        'Read a web page: title, url and visible text (optionally its form fields). With no `url` it reads the page the user is currently on. Pass a `url` to read ANY page yourself — NEVER ask the user to open a tab, just fetch it.',
      parameters: z.object({
        includeFields: z
          .boolean()
          .optional()
          .describe('Also return the form fields detected on the active tab'),
        url: z
          .string()
          .optional()
          .describe('Absolute http(s) URL to fetch and read yourself (no tab needed)'),
      }),
      execute: (params) => Promise.resolve(context.readPage(params)),
    }),

    fillForm: tool({
      description:
        'Fill form fields on the current page with the given values. NEVER auto-submits: `submit` must stay false unless the user explicitly asked to submit.',
      parameters: z.object({
        fields: z.array(fillInstructionSchema).describe('Fields to fill'),
        submit: z
          .boolean()
          .optional()
          .describe('Only true if the user explicitly confirmed submission'),
      }),
      execute: (params) => Promise.resolve(context.fillForm(params)),
    }),

    getProfile: tool({
      description:
        'Read the user’s stored profile from the vault (identity, education, experience, skills, projects, documents, customAnswers, preferences, or secrets). Prefer reading only the section you need.',
      parameters: z.object({
        section: z
          .enum(PROFILE_SECTIONS)
          .optional()
          .describe('Profile section to read; omit for a general profile summary'),
      }),
      execute: (params) => Promise.resolve(context.getProfile(params)),
    }),

    createReminder: tool({
      description:
        'Create a reminder / alarm for the user at a given time (ISO-8601 `dueAt`).',
      parameters: z.object({
        title: z.string().describe('What to be reminded about'),
        dueAt: z.string().describe('When, as an ISO-8601 date-time string'),
        notes: z.string().optional(),
      }),
      execute: (params) => Promise.resolve(context.createReminder(params)),
    }),

    listReminders: tool({
      description: 'List the user’s pending reminders.',
      parameters: z.object({}),
      execute: (params) => Promise.resolve(context.listReminders(params)),
    }),

    crawl: tool({
      description:
        'Fetch a URL (optionally following links up to `depth`) and return clean markdown. Runs in the background — use it for research without asking the user to open anything.',
      parameters: z.object({
        url: z.string().describe('Starting URL, including https://'),
        depth: z.number().int().min(0).optional().describe('Link-follow depth'),
        maxPages: z.number().int().min(1).optional().describe('Max pages to fetch'),
      }),
      execute: (params) => Promise.resolve(context.crawl(params)),
    }),

    searchWeb: tool({
      description:
        'Search the web and return ranked results (title, url, snippet). Runs in the background; use it to find things for the user instead of asking them to search.',
      parameters: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: (params) => Promise.resolve(context.searchWeb(params)),
    }),

    readInbox: tool({
      description:
        'Read recent Gmail messages (sender, subject, snippet). Use for "did I get any email about …?" — needs the user to have connected Google in settings.',
      parameters: z.object({
        query: z
          .string()
          .optional()
          .describe('Gmail search query, e.g. "is:unread from:linkedin newer_than:3d"'),
        max: z.number().int().min(1).max(25).optional().describe('How many messages to return'),
      }),
      execute: (params) => Promise.resolve(context.readInbox(params)),
    }),

    readCalendar: tool({
      description:
        'Read the user’s upcoming Google Calendar events. Use for "what do I have today/tomorrow?" — needs Google connected.',
      parameters: z.object({
        days: z.number().int().min(1).max(30).optional().describe('How many days ahead to look'),
        max: z.number().int().min(1).max(25).optional().describe('Max events'),
      }),
      execute: (params) => Promise.resolve(context.readCalendar(params)),
    }),

    notify: tool({
      description: 'Show a desktop / in-page notification to the user.',
      parameters: z.object({
        title: z.string(),
        body: z.string().optional(),
      }),
      execute: (params) => Promise.resolve(context.notify(params)),
    }),

    speak: tool({
      description:
        'Speak text out loud through the avatar (TTS). Use short, natural sentences. Supports Hindi, English and Hinglish.',
      parameters: z.object({
        text: z.string().describe('Text to speak'),
      }),
      execute: (params) => Promise.resolve(context.speak(params)),
    }),

    setMood: tool({
      description: 'Set the avatar’s facial expression / mood.',
      parameters: z.object({
        mood: z.enum(MOODS),
      }),
      execute: (params) => Promise.resolve(context.setMood(params)),
    }),

    playAnim: tool({
      description:
        'Play a full-body avatar animation state (greet, talk gesture, think, celebrate, exit, …).',
      parameters: z.object({
        state: z.enum(AVATAR_STATES),
      }),
      execute: (params) => Promise.resolve(context.playAnim(params)),
    }),
  };

  return assertCompleteToolset(tools);
}

/** Runtime guard: throws if any `ToolName` is missing from the toolset. */
export function assertCompleteToolset(tools: Toolset): Toolset {
  const missing = TOOL_NAMES.filter((name) => !(name in tools));
  if (missing.length > 0) {
    throw new Error(`Toolset is missing tools: ${missing.join(', ')}`);
  }
  return tools;
}

export { TOOL_NAMES } from './types';
export type { ToolContext, ToolExecutor } from './types';
