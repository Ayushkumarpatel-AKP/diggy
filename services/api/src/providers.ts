/**
 * The plugin registry.
 *
 * A "plugin" is something the assistant can talk to on the user's behalf. Each
 * entry describes how the extension should present it and how connection works.
 * `auth: 'none'` providers (YouTube) need no credentials at all — the extension
 * can use them with one click.
 */
export type ProviderAuthKind = 'oauth2' | 'none';

export type ProviderId = 'google' | 'notion' | 'github' | 'youtube';

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  description: string;
  /** Short glyph/emoji shown next to the plugin name. */
  icon: string;
  auth: ProviderAuthKind;
  /** OAuth scopes requested when connecting (empty for `auth: 'none'`). */
  scopes: string[];
  /** Where the user can read more / manage access. */
  docs: string;
}

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
];

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'google',
    name: 'Google',
    description: 'Read Gmail and manage your Google Calendar.',
    icon: '🔎',
    auth: 'oauth2',
    scopes: GOOGLE_SCOPES,
    docs: 'https://developers.google.com/identity/protocols/oauth2',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search your workspace and create pages.',
    icon: '📝',
    auth: 'oauth2',
    scopes: [],
    docs: 'https://developers.notion.com/docs/authorization',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'See your repos and open issues.',
    icon: '🐙',
    auth: 'oauth2',
    scopes: ['read:user', 'repo'],
    docs: 'https://docs.github.com/apps/oauth-apps',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    description: 'Find the latest video from any channel — no sign-in needed.',
    icon: '▶️',
    auth: 'none',
    scopes: [],
    docs: 'https://www.youtube.com/feeds/videos.xml',
  },
];

export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDERS;
}

export function getProvider(id: string): ProviderDefinition | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function isProviderId(id: string): id is ProviderId {
  return PROVIDERS.some((provider) => provider.id === id);
}
