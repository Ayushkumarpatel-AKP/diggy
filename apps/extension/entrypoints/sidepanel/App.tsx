import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toCoreMessages } from '@diggy/core';
import {
  InkBackground,
  SketchBadge,
  SketchButton,
  SketchCard,
  SketchInput,
  SketchToggle,
  ThinkingDots,
} from '@diggy/ui';
import type { AvatarMood, CardAction, ChatMessage, Profile, RichCard } from '@diggy/shared';
import { callContent, getBridgeStatus, recStart, recStop, recWarm, type BridgeEventMessage } from '../../src/messages';
import { isChordRelease, matchesShortcut } from '../../src/shortcut';
import {
  applyFillPlan,
  PlatformToolContext,
  speakText,
  type FillPlan,
} from '../../src/platform-context';
import { buildHeuristicPlan } from '../../src/field-mapper';
import { VaultPanel } from './VaultPanel';
import { RemindersPanel } from './RemindersPanel';
import { PagePanel } from './PagePanel';
import { WatchPanel } from './WatchPanel';
import { AppsPanel } from './AppsPanel';
import { PluginsPanel } from './PluginsPanel';
import { CardView } from './CardView';
import { getProfile, getSettings, saveSettings, type Settings } from '../../src/storage';
import { runResilient } from '../../src/brain';
import { clearChat, loadChat, saveChat } from '../../src/chat-memory';
import {
  captureWithHighlight,
  latestVideos,
  parseVideoRequest,
  snapshotCard,
  videoCard,
} from '../../src/cards';

function messageWithCard(role: ChatMessage['role'], content: string, card?: RichCard): ChatMessage {
  return card ? { ...message(role, content), card } : message(role, content);
}

/* ------------------------------------------------------------------ *
 * Speech recognition (Web Speech API) — minimal local typings
 * ------------------------------------------------------------------ */

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternative;
}
interface SpeechResultList {
  length: number;
  [index: number]: SpeechResult;
}
interface SpeechEvent {
  results: SpeechResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | undefined {
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

function uid(prefix = 'msg'): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function message(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: uid(), role, content, createdAt: new Date().toISOString() };
}

type View = 'chat' | 'vault' | 'reminders' | 'watch' | 'plugins' | 'apps' | 'page' | 'settings';

const TABS: ReadonlyArray<{
  id: View;
  label: string;
  icon: string;
  accent: 'sky' | 'amber' | 'green' | 'pink';
}> = [
  { id: 'chat', label: 'Chat', icon: '💬', accent: 'sky' },
  { id: 'vault', label: 'Profile', icon: '🔐', accent: 'pink' },
  { id: 'reminders', label: 'Reminders', icon: '⏰', accent: 'amber' },
  { id: 'watch', label: 'Watch', icon: '👀', accent: 'pink' },
  { id: 'plugins', label: 'Plugins', icon: '🧩', accent: 'green' },
  { id: 'apps', label: 'Apps', icon: '🔗', accent: 'green' },
  { id: 'page', label: 'Page', icon: '🌐', accent: 'green' },
];

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

export function App(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([
    message(
      'assistant',
      'Hi! I’m Diggy. Ask me to read a page, fill a form, set a reminder or research something — I’ll always show you a plan before I touch a form.',
    ),
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [plan, setPlan] = useState<FillPlan | null>(null);
  const [mood, setMood] = useState<AvatarMood>('neutral');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bridge, setBridge] = useState<{ connected: boolean; url: string }>({ connected: false, url: '' });
  const [view, setView] = useState<View>('chat');
  const [brainProvider, setBrainProvider] = useState<string>('');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const context = useMemo(
    () => new PlatformToolContext({ onFillPlan: setPlan, onMood: setMood }),
    [],
  );

  const push = useCallback((role: ChatMessage['role'], content: string) => {
    setMessages((current) => [...current, message(role, content)]);
  }, []);

  const updateById = useCallback((id: string, updater: (content: string) => string) => {
    setMessages((current) =>
      current.map((item) => (item.id === id ? { ...item, content: updater(item.content) } : item)),
    );
  }, []);

  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  /* --- init ------------------------------------------------------------- */

  useEffect(() => {
    void (async () => {
      // Restore the conversation memory first, then settings + bridge status.
      const stored = await loadChat();
      if (stored.length > 0) setMessages(stored);
      setSettings(await getSettings());
      const status = await getBridgeStatus();
      setBridge({ connected: status.connected, url: status.url });
    })();
  }, []);

  // Persist the conversation (capped) whenever a turn finishes.
  useEffect(() => {
    if (!busy) void saveChat(messages);
  }, [busy, messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  /* --- desktop bridge events ------------------------------------------- */

  useEffect(() => {
    const listener = (raw: unknown): undefined => {
      if (typeof raw !== 'object' || raw === null) return undefined;
      const event = raw as { type?: unknown; event?: unknown; payload?: unknown };
      if (event.type === 'diggy:bridge-event') {
        const bridgeEvent = raw as BridgeEventMessage;
        if (bridgeEvent.event === 'avatar') {
          const payload = bridgeEvent.payload as { mood?: AvatarMood } | undefined;
          if (payload?.mood) setMood(payload.mood);
        }
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  /* --- assistant -------------------------------------------------------- */

  const respond = useCallback(
    async (history: ChatMessage[]) => {
      const assistantId = uid('assistant');
      setMessages((current) => [
        ...current,
        { id: assistantId, role: 'assistant', content: '', createdAt: new Date().toISOString() },
      ]);
      setBusy(true);
      context.takeCards(); // drop anything stale from an earlier turn
      try {
        const active = settings ?? (await getSettings());
        // Automatic Groq ⇄ NVIDIA failover happens inside runResilient.
        const result = await runResilient({
          settings: active,
          messages: toCoreMessages(history),
          makeContext: () => context,
          onDelta: (_delta, full) => updateById(assistantId, () => full),
        });
        const text = result.text.trim() || '(Diggy had nothing to add.)';
        const cards = context.takeCards();
        patchMessage(assistantId, cards[0] ? { content: text, card: cards[0] } : { content: text });
        setBrainProvider(result.provider);
        if (active.voiceEnabled && text.length <= 320 && !text.startsWith('⚠️')) speakText(text);
      } catch (error) {
        updateById(assistantId, () => `⚠️ ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [settings, context, updateById, patchMessage],
  );

  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const userMessage = message('user', trimmed);
      const history = [...messages, userMessage];
      setMessages(history);

      // "MrBeast ka latest video" → resolve it here so we can show a real card.
      const channel = parseVideoRequest(trimmed);
      if (channel) {
        setBusy(true);
        let handled = false;
        try {
          const video = (await latestVideos(channel, 1))[0];
          setMessages([
            ...history,
            video
              ? messageWithCard(
                  'assistant',
                  `Ye raha ${channel} ka latest video 👇`,
                  videoCard({
                    videoId: video.videoId,
                    title: video.title,
                    url: video.url,
                    thumbnail: video.thumbnail,
                    published: video.published,
                    channel,
                  }),
                )
              : message('assistant', `I couldn’t find a channel called “${channel}”. Try the exact name.`),
          ]);
          setMood(video ? 'happy' : 'neutral');
          handled = true;
        } catch {
          /* fall through to the model */
        } finally {
          setBusy(false);
        }
        if (handled) return;
        setMessages(history);
      }

      await respond(history);
    },
    [busy, messages, respond],
  );

  const handleCardAction = useCallback(
    async (action: CardAction) => {
      if (action.kind === 'link') {
        await browser.tabs.create({ url: action.value });
        return;
      }
      await sendText(action.value);
    },
    [sendText],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    await sendText(text);
  }, [input, busy, sendText]);

  const clearConversation = useCallback(async () => {
    await clearChat();
    setMessages([message('assistant', 'Chat cleared. What shall we do next?')]);
  }, []);

  /* --- mic -------------------------------------------------------------- */

  const enableVoice = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      push('assistant', 'This browser cannot access the microphone.');
      return;
    }
    try {
      // 1. Grant the mic for the whole extension (the offscreen recorder reuses it).
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      // 2. Warm the offscreen recorder so the first push-to-talk is instant.
      const warm = await recWarm();
      if (warm?.ok === true) {
        setMicReady(true);
        push(
          'assistant',
          `🎙 Microphone ready — hold ${settings?.shortcut || 'Ctrl+Shift+Space'} on any page (or right here in the panel), speak, then release.`,
        );
      } else {
        setMicReady(false);
        push('assistant', `🎙 ${warm?.error ?? 'Microphone could not be prepared — try again.'}`);
      }
    } catch {
      push('assistant', 'Microphone permission was denied. Allow it for this extension and retry.');
    }
  }, [push, settings?.shortcut]);

  /* --- push-to-talk (also works while the panel has focus) -------------- */

  const voiceHoldingRef = useRef(false);

  useEffect(() => {
    const spec = settings?.shortcut?.trim() || 'Ctrl+Shift+Space';

    const begin = async (): Promise<void> => {
      if (voiceHoldingRef.current) return;
      voiceHoldingRef.current = true;
      setListening(true);
      try {
        const result = await recStart();
        if (!result?.ok) {
          voiceHoldingRef.current = false;
          setListening(false);
          push('assistant', result?.error ?? 'Microphone unavailable — click 🎙 once to allow it.');
        }
      } catch (error) {
        voiceHoldingRef.current = false;
        setListening(false);
        push('assistant', `Voice failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const end = async (): Promise<void> => {
      if (!voiceHoldingRef.current) return;
      voiceHoldingRef.current = false;
      setListening(false);
      try {
        const result = await recStop();
        if (!result?.ok) push('assistant', 'I could not hear anything — try again.');
      } catch {
        push('assistant', 'Voice failed — try again.');
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || !matchesShortcut(event, spec)) return;
      event.preventDefault();
      void begin();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (voiceHoldingRef.current && isChordRelease(event, spec)) void end();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [settings?.shortcut, push]);

  /* --- quick actions ---------------------------------------------------- */

  const quickReadPage = useCallback(async () => {
    setBusy(true);
    try {
      const page = await callContent('readPage', { includeFields: true });
      const fields = page.fields ?? [];
      const labels = fields
        .slice(0, 10)
        .map((field) => field.label || field.name || field.type || 'field')
        .join(', ');
      push(
        'assistant',
        `📄 ${page.title}\n${page.url}\n${fields.length} field(s)${labels ? `: ${labels}` : ''}`,
      );
      setMood('thinking');
    } catch (error) {
      push('assistant', `Couldn’t read this page: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [push]);

  const quickPlanFill = useCallback(async () => {
    setBusy(true);
    try {
      const page = await callContent('readPage', { includeFields: true });
      const fields = page.fields ?? [];
      const profile: Profile | null = await getProfile();
      if (!profile) {
        push('assistant', 'I don’t have your profile cached yet, so I can’t map these fields.');
        return;
      }
      const fields2 = buildHeuristicPlan(fields, profile);
      if (fields2.length === 0) {
        push('assistant', 'I couldn’t confidently map any field on this page.');
        return;
      }
      setPlan({ fields: fields2, createdAt: new Date().toISOString() });
      push('assistant', `I found ${fields2.length} field(s) I can fill. Review the plan and hit “Fill”.`);
      setMood('happy');
    } catch (error) {
      push('assistant', `Couldn’t plan a fill: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [push]);

  const quickProfile = useCallback(async () => {
    const profile = await getProfile();
    if (!profile) {
      push('assistant', 'No profile is cached in this extension yet.');
      return;
    }
    push(
      'assistant',
      `👤 ${profile.identity.fullName || '(no name)'} · ${profile.identity.email ?? 'no email'}\n` +
        `${profile.skills.length} skill(s), ${profile.experience.length} role(s), ${profile.education.length} education entr(ies).`,
    );
  }, [push]);

  const confirmPlan = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const result = await applyFillPlan(plan.fields);
      let card: RichCard | undefined;
      try {
        // Proof, not a promise: the filled page, exactly as it looks right now.
        const imageDataUrl = await captureWithHighlight();
        const page = await callContent('readPage', { includeFields: false }).catch(() => undefined);
        card = snapshotCard({
          title: `Filled ${result.filled} field(s)`,
          subtitle: 'Nothing was submitted — check it, then submit yourself.',
          imageDataUrl,
          url: page?.url,
          badge: 'snapshot',
          actions: page?.url
            ? [{ id: 'open', label: 'Open page', kind: 'link', value: page.url, variant: 'primary' }]
            : undefined,
        });
      } catch {
        /* a snapshot is nice-to-have, never required */
      }
      setMessages((current) => [
        ...current,
        messageWithCard(
          'assistant',
          `✅ Filled ${result.filled} field(s)${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}. Nothing was submitted.`,
          card,
        ),
      ]);
      setMood('happy');
      await callContent('setMood', { mood: 'happy' }).catch(() => undefined);
    } catch (error) {
      push('assistant', `Couldn’t fill the form: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPlan(null);
      setBusy(false);
    }
  }, [plan, push]);

  const updateSetting = useCallback(
    async (patch: Partial<Settings>) => {
      const next = await saveSettings(patch);
      setSettings(next);
    },
    [],
  );

  const refreshBridge = useCallback(async () => {
    const status = await getBridgeStatus();
    setBridge({ connected: status.connected, url: status.url });
  }, []);

  const connectBridge = useCallback(async () => {
    await browser.runtime.sendMessage({ type: 'diggy:bridge-connect' });
    window.setTimeout(() => void refreshBridge(), 1500);
  }, [refreshBridge]);

  const disconnectBridge = useCallback(async () => {
    await browser.runtime.sendMessage({ type: 'diggy:bridge-disconnect' });
    window.setTimeout(() => void refreshBridge(), 400);
  }, [refreshBridge]);

  /* --- render ----------------------------------------------------------- */

  const bridgeLabel = bridge.connected ? 'Desktop linked' : 'Offline mode';

  return (
    <InkBackground className="h-full" opacity={0.5} density={5} interactive>
      <div className="diggy-root flex h-full flex-col gap-3 p-3 text-ink">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <SketchBadge accent="violet" size="lg" dot>
              Diggy
            </SketchBadge>
            <SketchBadge accent={bridge.connected ? 'green' : 'amber'} size="sm">
              {bridgeLabel}
            </SketchBadge>
            <SketchBadge accent="sky" size="sm">
              {brainProvider || settings?.provider || 'groq'}
            </SketchBadge>
            {listening ? (
              <SketchBadge accent="pink" size="sm" dot>
                🎙 listening
              </SketchBadge>
            ) : null}
          </div>
          <SketchButton
            size="sm"
            variant={view === 'settings' ? 'accent' : 'ghost'}
            accent="sky"
            aria-label="Settings"
            title="Settings"
            onClick={() => setView((current) => (current === 'settings' ? 'chat' : 'settings'))}
          >
            ⚙
          </SketchButton>
        </header>

        <nav className="flex items-center gap-1" aria-label="Diggy sections">
          {TABS.map((tab) => (
            <SketchButton
              key={tab.id}
              size="sm"
              variant={view === tab.id ? 'accent' : 'ghost'}
              accent={tab.accent}
              aria-pressed={view === tab.id}
              aria-label={tab.label}
              title={tab.label}
              onClick={() => setView(tab.id)}
            >
              <span aria-hidden="true">{tab.icon}</span>
            </SketchButton>
          ))}
          <span className="ml-1 truncate text-xs font-semibold text-ink-500">
            {view === 'settings' ? 'Settings' : (TABS.find((tab) => tab.id === view)?.label ?? '')}
          </span>
        </nav>

        {view === 'settings' ? (
          <div className="diggy-scrollbar flex-1 space-y-3 overflow-y-auto pr-1">
        {settings ? (
          <SketchCard tone="muted" className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Brain</span>
              <SketchButton
                size="sm"
                variant={settings.provider === 'groq' ? 'accent' : 'ghost'}
                accent="green"
                onClick={() => void updateSetting({ provider: 'groq' })}
              >
                Groq
              </SketchButton>
              <SketchButton
                size="sm"
                variant={settings.provider === 'nvidia' ? 'accent' : 'ghost'}
                accent="sky"
                onClick={() => void updateSetting({ provider: 'nvidia' })}
              >
                NVIDIA
              </SketchButton>
            </div>
            <SketchInput
              label="Groq API key"
              type="password"
              placeholder="gsk_…"
              value={settings.groqKey}
              onChange={(event) => void updateSetting({ groqKey: event.target.value })}
            />
            <SketchInput
              label="NVIDIA API key"
              type="password"
              placeholder="nvapi-…"
              value={settings.nvidiaKey}
              onChange={(event) => void updateSetting({ nvidiaKey: event.target.value })}
            />
            <SketchInput
              label="Model (optional)"
              placeholder="openai/gpt-oss-120b"
              value={settings.model}
              onChange={(event) => void updateSetting({ model: event.target.value })}
            />
            <SketchInput
              label="Push-to-talk shortcut"
              placeholder="Ctrl+Shift+Space"
              value={settings.shortcut}
              onChange={(event) => void updateSetting({ shortcut: event.target.value })}
            />
            <SketchInput
              label="Crawler URL"
              placeholder="http://127.0.0.1:17322"
              value={settings.crawlerUrl}
              onChange={(event) => void updateSetting({ crawlerUrl: event.target.value })}
            />
            <SketchInput
              label="Plugins backend URL"
              placeholder="http://127.0.0.1:17323"
              value={settings.apiUrl}
              onChange={(event) => void updateSetting({ apiUrl: event.target.value })}
            />
            <SketchInput
              label="Desktop bridge URL"
              value={settings.bridgeUrl}
              onChange={(event) => void updateSetting({ bridgeUrl: event.target.value })}
            />
            <SketchInput
              label="Desktop bridge token"
              type="password"
              placeholder="shared token (from the bridge server log)"
              value={settings.bridgeToken}
              onChange={(event) => void updateSetting({ bridgeToken: event.target.value })}
            />
            <div className="flex items-center gap-2">
              <SketchButton size="sm" variant="accent" accent="green" onClick={() => void connectBridge()}>
                Connect bridge
              </SketchButton>
              <SketchButton size="sm" variant="ghost" onClick={() => void disconnectBridge()}>
                Disconnect
              </SketchButton>
              <span className="text-xs text-ink-500">{bridge.connected ? 'connected ✓' : 'offline'}</span>
            </div>
            <div className="flex items-center justify-between">
              <SketchToggle
                label="Speak replies"
                checked={settings.voiceEnabled}
                onCheckedChange={(checked) => void updateSetting({ voiceEnabled: checked })}
              />
              <SketchToggle
                label="Avatar bubble"
                checked={settings.avatarVisible}
                onCheckedChange={(checked) => void updateSetting({ avatarVisible: checked })}
              />
            </div>
            <p className="text-[11px] leading-snug text-ink-500">
              Hold <span className="font-semibold">{settings.shortcut}</span> on any page to talk to
              Diggy — the reply appears above the bot and is spoken aloud. If one provider hits its
              limit, Diggy automatically falls back to the other.
            </p>
            <div className="flex items-center gap-2">
              <SketchButton size="sm" variant="ghost" onClick={() => void clearConversation()}>
                Clear chat
              </SketchButton>
              <span className="text-[11px] text-ink-500">Active brain: {brainProvider || settings.provider}</span>
            </div>
          </SketchCard>
        ) : null}
            <SketchButton size="sm" variant="ghost" onClick={() => setView('chat')}>
              ← Back to chat
            </SketchButton>
          </div>
        ) : view === 'chat' ? (
          <>

        <div ref={scrollRef} className="diggy-scrollbar flex-1 space-y-2 overflow-y-auto pr-1">
          {messages.map((item) => (
            <div key={item.id} className={item.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className="max-w-[92%] space-y-1.5">
                <SketchCard
                  tone={item.role === 'user' ? 'accent' : 'paper'}
                  accent={item.role === 'user' ? 'sky' : 'amber'}
                  padded
                  className="whitespace-pre-wrap text-sm leading-relaxed"
                >
                  {item.content || (busy ? <ThinkingDots size="sm" /> : '')}
                </SketchCard>
                {item.card ? (
                  <CardView card={item.card} onAction={(action) => void handleCardAction(action)} />
                ) : null}
              </div>
            </div>
          ))}
        </div>

        {plan ? (
          <SketchCard tone="accent" accent="green" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <SketchBadge accent="green" dot>
                Confirm fill
              </SketchBadge>
              <span className="text-xs text-ink-500">{plan.fields.length} field(s)</span>
            </div>
            <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-ink-700">
              {plan.fields.map((field) => (
                <li key={field.fieldId} className="truncate">
                  <span className="font-semibold">{field.profilePath ?? field.fieldId}</span> →{' '}
                  {field.value.length > 40 ? `${field.value.slice(0, 40)}…` : field.value}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <SketchButton variant="accent" accent="green" size="sm" onClick={() => void confirmPlan()}>
                Fill
              </SketchButton>
              <SketchButton variant="ghost" size="sm" onClick={() => setPlan(null)}>
                Cancel
              </SketchButton>
              <span className="text-[11px] text-ink-500">Diggy never submits.</span>
            </div>
          </SketchCard>
        ) : null}

        <div className="flex flex-wrap gap-1.5">
          <SketchButton size="sm" variant="paper" onClick={() => void quickReadPage()}>
            Scan page
          </SketchButton>
          <SketchButton size="sm" variant="paper" onClick={() => void quickPlanFill()}>
            Fill form
          </SketchButton>
          <SketchButton size="sm" variant="paper" onClick={() => void quickProfile()}>
            My profile
          </SketchButton>
        </div>

        <div className="flex items-end gap-2">
          <SketchInput
            containerClassName="flex-1"
            placeholder="Ask Diggy…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
          />
          <SketchButton
            size="md"
            variant={micReady ? 'accent' : 'paper'}
            accent="pink"
            aria-label="Enable microphone"
            title={micReady ? 'Microphone ready' : 'Enable microphone'}
            onClick={() => void enableVoice()}
          >
            🎙
          </SketchButton>
          <SketchButton
            size="md"
            variant="ink"
            accent="sky"
            loading={busy}
            onClick={() => void handleSend()}
          >
            Send
          </SketchButton>
        </div>
          </>
        ) : view === 'vault' ? (
          <VaultPanel onClose={() => setView('chat')} />
        ) : view === 'reminders' ? (
          <RemindersPanel onClose={() => setView('chat')} />
        ) : view === 'watch' ? (
          <WatchPanel onClose={() => setView('chat')} />
        ) : view === 'plugins' ? (
          <PluginsPanel onClose={() => setView('chat')} />
        ) : view === 'apps' ? (
          <AppsPanel onClose={() => setView('chat')} />
        ) : (
          <PagePanel onClose={() => setView('chat')} />
        )}
      </div>
    </InkBackground>
  );
}
