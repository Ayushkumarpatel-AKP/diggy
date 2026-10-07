/**
 * Offscreen recorder document.
 *
 * Created on demand by the background worker. It owns the microphone
 * (`getUserMedia` + `MediaRecorder`) because a content script would need the
 * *page's* mic permission, while the extension origin asks once for the whole
 * extension. `rec-start` begins recording; `rec-stop` returns the audio as
 * base64 so the background can send it to Whisper.
 *
 * This is why voice works in Edge/Chrome regardless of the browser's own
 * (usually blocked or unavailable) Web Speech service.
 *
 * Toggle mode (Phase 5)
 * ---------------------
 * `chrome.commands` has NO key-up event, so a browser-level push-to-talk
 * shortcut can only ever toggle. When the start message carries
 * `autoStop: true` this document also measures the mic level with an
 * `AnalyserNode` and asks the background to stop once the user has clearly
 * stopped speaking — so a toggle press "just works" without a second press.
 * Hold-to-talk (no `autoStop`) behaves exactly as before.
 *
 * The recorder never decides to keep or drop a clip: it only *asks* the
 * background (which owns the single stop/transcribe path), so audio can never
 * be streamed twice or dropped. No audio is ever logged — only the error name
 * of a failed `getUserMedia`.
 */
import type { MicErrorReason, OffscreenStartResult } from '../../src/messages';

/**
 * Silence threshold, as normalised RMS of the time-domain waveform (0..1,
 * where 0.02 ≈ −34 dBFS). Room noise and breathing sit well below this,
 * ordinary speech well above it.
 */
export const SILENCE_RMS_THRESHOLD = 0.02;

/** How long the level must stay under the threshold before we stop (toggle mode). */
export const SILENCE_STOP_MS = 1_200;

/** Hard cap: never record longer than this, however noisy or quiet the room is. */
export const MAX_RECORDING_MS = 60_000;

/**
 * If nothing above the threshold is ever heard, give up early instead of
 * holding the mic open for the full minute (a stray toggle press, or a muted
 * microphone).
 */
export const NO_SPEECH_TIMEOUT_MS = 10_000;

/** How often the level meter samples the microphone. */
const LEVEL_SAMPLE_MS = 50;

/** FFT size for the level meter — small is plenty for a loudness reading. */
const ANALYSER_FFT_SIZE = 2048;

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];

/* --- silence auto-stop state (toggle mode only) --------------------- */

let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
// Typed from the analyser's own signature so this compiles on every TS version.
let levelBuffer: Parameters<AnalyserNode['getByteTimeDomainData']>[0] | null = null;
let levelTimer: number | null = null;
let autoStopEnabled = false;
let autoStopSignalled = false;
let startedAt = 0;
let lastVoiceAt = 0;
let heardVoice = false;

function stopLevelMeter(): void {
  if (levelTimer !== null) {
    window.clearInterval(levelTimer);
    levelTimer = null;
  }
  if (audioContext) {
    // Closing the context also releases the analyser; the mic stream itself is
    // stopped separately in `cleanup()`.
    void audioContext.close().catch(() => undefined);
    audioContext = null;
  }
  analyser = null;
  levelBuffer = null;
}

function cleanup(): void {
  stopLevelMeter();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  recorder = null;
  chunks = [];
  autoStopEnabled = false;
  autoStopSignalled = false;
  heardVoice = false;
}

/** `getUserMedia` failure → the reason the background needs to act on. */
function classifyMicError(error: unknown): MicErrorReason {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'not-allowed';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no-device';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'device-busy';
  return 'unknown';
}

/** Normalised RMS of the current waveform (0..1). */
function currentLevel(): number {
  const meter = analyser;
  const buffer = levelBuffer;
  if (!meter || !buffer) return 0;
  meter.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    // Byte data is centred on 128; normalise to −1..1 before squaring.
    const sample = (buffer[index]! - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / buffer.length);
}

/**
 * Ask the background to stop (and transcribe). The recorder is left running on
 * purpose: the background's `diggy:offscreen-stop` is the only teardown path.
 */
function requestAutoStop(reason: 'silence' | 'max-duration' | 'no-speech'): void {
  stopLevelMeter();
  if (autoStopSignalled) return;
  autoStopSignalled = true;
  void browser.runtime
    .sendMessage({ type: 'diggy:offscreen-silence', reason })
    .catch(() => undefined);
}

function levelTick(): void {
  if (!recorder || recorder.state === 'inactive') {
    stopLevelMeter();
    return;
  }
  const now = Date.now();
  if (currentLevel() >= SILENCE_RMS_THRESHOLD) {
    heardVoice = true;
    lastVoiceAt = now;
  }
  if (now - startedAt >= MAX_RECORDING_MS) {
    requestAutoStop('max-duration');
    return;
  }
  if (!heardVoice && now - startedAt >= NO_SPEECH_TIMEOUT_MS) {
    requestAutoStop('no-speech');
    return;
  }
  if (heardVoice && now - lastVoiceAt >= SILENCE_STOP_MS) requestAutoStop('silence');
}

/** Start the level meter. Silently degrades to "press again to stop" if it fails. */
function startLevelMeter(): void {
  try {
    const scope = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor || !stream) {
      autoStopEnabled = false;
      return;
    }
    audioContext = new Ctor();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0.2;
    // The analyser is a pure sink — it is never connected to the destination,
    // so nothing is played back.
    source.connect(analyser);
    levelBuffer = new Uint8Array(analyser.fftSize);
    levelTimer = window.setInterval(levelTick, LEVEL_SAMPLE_MS);
  } catch {
    stopLevelMeter();
    autoStopEnabled = false;
  }
}

async function startRecording(options: { autoStop?: boolean } = {}): Promise<OffscreenStartResult> {
  if (recorder) return { ok: true };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    cleanup();
    // Never log the audio/device details — only the error name/message.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, reason: classifyMicError(error) };
  }

  try {
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : 'audio/webm';
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();
  } catch (error) {
    cleanup();
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, reason: 'unknown' };
  }

  // Toggle mode: arm the silence meter. Hold mode stays on the key-up path.
  autoStopEnabled = options.autoStop === true;
  autoStopSignalled = false;
  heardVoice = false;
  startedAt = Date.now();
  lastVoiceAt = startedAt;
  if (autoStopEnabled) startLevelMeter();

  return { ok: true };
}

function stopRecording(): Promise<{ ok: boolean; base64?: string; mime?: string; error?: string }> {
  return new Promise((resolve) => {
    const active = recorder;
    if (!active) {
      resolve({ ok: false, error: 'not recording' });
      return;
    }
    // Stop metering first so a pending tick cannot ask for a second stop.
    stopLevelMeter();
    autoStopSignalled = true;
    active.onstop = async () => {
      try {
        const type = active.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (blob.size === 0) {
          cleanup();
          resolve({ ok: false, error: 'no audio captured' });
          return;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const base64 = btoa(binary);
        cleanup();
        resolve({ ok: true, base64, mime: type });
      } catch (error) {
        cleanup();
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };
    try {
      active.stop();
    } catch (error) {
      cleanup();
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * Internal message names. The background is the only thing that talks to this
 * document — the content script's `diggy:rec-start` must NOT reach us directly,
 * or the recorder races the background's document creation.
 */
browser.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as { type?: string; autoStop?: boolean } | undefined;
  if (!message) return undefined;
  // Readiness probe: the background waits for this before sending any work.
  if (message.type === 'diggy:offscreen-ping') return Promise.resolve({ ok: true });
  if (message.type === 'diggy:offscreen-start') {
    return startRecording({ autoStop: message.autoStop === true });
  }
  if (message.type === 'diggy:offscreen-stop') return stopRecording();
  if (message.type === 'diggy:offscreen-warm') {
    // Pre-warm the mic so the first push-to-talk is instant. Never auto-stop:
    // the warm-up is stopped immediately below.
    return startRecording({ autoStop: false }).then((result) => {
      if (result.ok) {
        // Immediately stop so we do not hold the mic open; permission is cached.
        void stopRecording();
      }
      return result;
    });
  }
  return undefined;
});
