/**
 * Diggy extension — canned, user-facing text.
 *
 * ONE HOME RULE: every string a user can read lives here, as a plain string or
 * a template function — never inlined at a call site. Wording changes happen in
 * exactly one place. ENGLISH ONLY: no Hinglish, no Devanagari, in the strings
 * or these comments. Emoji that carry meaning (👇 ⏰ 🎙 ✅ …) are kept — the
 * rule is about language, not symbols.
 *
 * Import-safe everywhere: this module references no `browser`, `window`, React
 * or DOM — just strings and template functions — so it can be pulled into the
 * background worker, a content script, the side panel and tests alike.
 *
 * Texts are grouped by the surface that shows them (video cards, reminders,
 * voice, …) and each preserves the exact meaning of the literal it replaces.
 */

export const STRINGS = {
  video: {
    /** Video resolved — shown above the thumbnail card. */
    latest: (channel: string) => `Here's ${channel}'s latest video 👇`,
    /** Background worker found no video; offers the exact search URL. */
    notFound: (channel: string, searchUrl: string) =>
      `I couldn't find a video for "${channel}" yet. Try this YouTube search — or say the channel's full name: ${searchUrl}`,
    /** Title of the fallback YouTube-search link card. */
    searchCardTitle: (channel: string) => `Search "${channel} latest video"`,
    /** Subtitle of that fallback link card. */
    searchCardSubtitle: 'YouTube search',
    /** Side-panel fallback when a channel name resolves to nothing. */
    panelNotFound: (channel: string) =>
      `I couldn't find a channel called "${channel}". Try the exact name.`,
  },

  reminder: {
    /** Notification / bubble title. */
    firedTitle: (title: string) => `⏰ ${title}`,
    /** Notification body when a reminder fires. */
    firedBody: (time: string, note?: string) =>
      note?.trim() || (time ? `${time} — this is due now!` : 'This is due now!'),
    /** In-page bubble text (also spoken) when a reminder fires. */
    firedInPage: (title: string, time: string, note?: string) =>
      `⏰ ${title} — ${time ? `${time} is due now` : 'it is due now'}! ${note ?? 'Time to do it.'}`,
    /** Card action value that asks the agent to list reminders. */
    listAction: 'Show my reminders',
  },

  voice: {
    /** Mic granted and the offscreen recorder is warmed up. */
    micReady: (shortcut: string) =>
      `🎙 Microphone ready — hold ${shortcut} on any page (or right here in the panel), speak, then release.`,
    /** The user denied the microphone permission. */
    micDenied: 'Microphone permission was denied. Allow it for this extension and try again.',
    /** The browser exposes no mediaDevices API. */
    noMicSupport: 'This browser cannot access the microphone.',
    /** The background worker cannot start the recorder at all. */
    recordingUnavailable: 'Recording is unavailable in this browser.',
    /** The offscreen recorder did not answer the warm-up ping. */
    recorderUnavailable: 'No response from the recorder.',
    /** Generic microphone failure from the background worker. */
    micUnavailable: 'Microphone unavailable.',
    /** Microphone failure hint shown by the background worker. */
    micUnavailableHint: 'Microphone unavailable — click 🎙 in the side panel once to allow it.',
    /** Microphone failure hint shown in the side panel. */
    micUnavailablePanel: 'Microphone unavailable — click 🎙 once to allow it.',
    /** Microphone failure hint shown in the in-page bubble. */
    micUnavailableBubble: 'Microphone unavailable — open the side panel and click 🎙 once.',
    /** Warm-up failed for a reason other than permission. */
    micPrepareFailed: 'Microphone could not be prepared — try again.',
    /** Stop happened with no captured audio. */
    noAudio: 'No audio captured — try holding the key a little longer.',
    /** Transcription came back empty (background worker). */
    couldNotHear: 'I could not hear anything.',
    /** Transcription came back empty (side panel). */
    couldNotHearRetry: 'I could not hear anything — try again.',
    /** Generic voice failure (background worker). */
    voiceFailed: 'Voice failed.',
    /** Generic voice failure (side panel). */
    voiceFailedRetry: 'Voice failed — try again.',
    /** Voice failure with the underlying reason appended. */
    voiceFailedWith: (detail: string) => `Voice failed: ${detail}`,
    /** Toggle-shortcut confirmation shown while recording. */
    listening: '🎙 Listening… press the shortcut again to send.',
    /** Voice input needs a Groq key. */
    needsGroqKey: 'Add a Groq API key in ⚙ Settings to use voice input.',
    /** Whisper transcription HTTP failure. */
    transcriptionFailed: (status: number, detail?: string) =>
      `Transcription failed (${status})${detail?.trim() ? ` ${detail.trim()}` : ''}`,
    /** Shown when the brain produced no answer. */
    noAnswer: 'Diggy could not answer — please try again.',
  },

  keys: {
    /** The brain has no provider key configured. */
    missing: 'I don’t have a brain configured yet — add a Groq or NVIDIA API key in ⚙ Settings.',
    /** Short heading for the missing-key state. */
    missingTitle: 'Add an API key',
    /** Body explaining how to add the key. */
    missingBody: 'Diggy needs a Groq or NVIDIA key. Open Settings (⚙) and paste one in.',
  },

  errors: {
    /** No active tab to forward a content call to. */
    noActiveTab: 'No active tab to talk to',
    /** The content script was unreachable or said nothing. */
    contentNoResponse: 'The content script did not respond',
  },

  notify: {
    /** Default notification body when none is supplied. */
    defaultBody: 'Diggy reminder',
  },

  menu: {
    /** Context-menu entry. */
    ask: 'Ask Diggy',
  },

  watch: {
    /** A watched page matched its keyword. */
    keywordHit: (label: string, keyword: string) =>
      `🎉 ${label}: I spotted "${keyword}" — go check it now!`,
    /** A watched page changed, without a keyword match. */
    changed: (label: string) => `👀 ${label} just changed — worth a look.`,
    /** Notification title prefix for a watch alert. */
    notificationTitle: (label: string) => `Diggy · ${label}`,
  },

  google: {
    /** Inbox alert line: celebration emoji for important mail, envelope otherwise. */
    mail: (important: boolean, sender: string, subject: string) =>
      `${important ? '🎉' : '📧'} ${sender}: ${subject}`,
    /** Fallback sender label when a message has no usable From header. */
    unknownSender: 'New mail',
    /** Notification title for a mail alert. */
    mailTitle: (important: boolean) => (important ? 'Diggy · important email' : 'Diggy · new email'),
    /** Calendar event alert line. */
    event: (summary: string, when: string) => `⏰ ${summary} — ${when}`,
    /** Calendar "when" phrases. */
    startingNow: 'starting now',
    inMinutes: (minutes: number) => `in ${minutes} min`,
    /** Calendar notification title. */
    eventTitle: 'Diggy · calendar',
  },
} as const;
