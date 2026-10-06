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
 */
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];

function cleanup(): void {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  recorder = null;
  chunks = [];
}

async function startRecording(): Promise<{ ok: boolean; error?: string }> {
  if (recorder) return { ok: true };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
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
    return { ok: true };
  } catch (error) {
    cleanup();
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function stopRecording(): Promise<{ ok: boolean; base64?: string; mime?: string; error?: string }> {
  return new Promise((resolve) => {
    const active = recorder;
    if (!active) {
      resolve({ ok: false, error: 'not recording' });
      return;
    }
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
  const message = raw as { type?: string } | undefined;
  if (!message) return undefined;
  // Readiness probe: the background waits for this before sending any work.
  if (message.type === 'diggy:offscreen-ping') return Promise.resolve({ ok: true });
  if (message.type === 'diggy:offscreen-start') return startRecording();
  if (message.type === 'diggy:offscreen-stop') return stopRecording();
  if (message.type === 'diggy:offscreen-warm') {
    // Pre-warm the mic so the first push-to-talk is instant.
    return startRecording().then((result) => {
      if (result.ok) {
        // Immediately stop so we do not hold the mic open; permission is cached.
        void stopRecording();
      }
      return result;
    });
  }
  return undefined;
});
