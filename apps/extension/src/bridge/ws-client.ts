/**
 * Typed WebSocket bridge client.
 *
 * Talks the `@diggy/shared` protocol to the (optional) desktop companion:
 * performs the `hello` → `welcome` handshake, correlates request/response pairs
 * by id, forwards events, and reconnects with exponential backoff.
 *
 * It is built to **never take down the service worker**: every WebSocket
 * interaction is guarded, and a missing desktop app simply means "reconnecting
 * forever in the background".
 */
import {
  BRIDGE_PROTOCOL_VERSION,
  isBridgeEvent,
  isBridgeResponse,
  type BridgeEvent,
  type BridgeMessage,
  type BridgeMethod,
  type BridgeRequest,
  type MethodParams,
  type MethodResults,
} from '@diggy/shared';

export type BridgeStatus = 'idle' | 'connecting' | 'handshaking' | 'open' | 'closed' | 'reconnecting';

export interface BridgeClientOptions {
  url: string;
  token: string;
  protocol?: number;
  role?: 'extension' | 'desktop';
  minDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Injectable WebSocket implementation (tests / non-browser hosts). */
  websocket?: typeof WebSocket;
  onStatusChange?: (status: BridgeStatus) => void;
  onEvent?: (event: BridgeEvent) => void;
  onError?: (error: unknown) => void;
}

interface PendingRequest {
  method: BridgeMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class WsBridgeClient {
  private readonly options: Required<
    Pick<BridgeClientOptions, 'protocol' | 'role' | 'minDelayMs' | 'maxDelayMs' | 'requestTimeoutMs' | 'handshakeTimeoutMs'>
  > &
    BridgeClientOptions;

  private socket: WebSocket | null = null;
  private _status: BridgeStatus = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: BridgeClientOptions) {
    this.options = {
      minDelayMs: 500,
      maxDelayMs: 30_000,
      requestTimeoutMs: 20_000,
      handshakeTimeoutMs: 6_000,
      protocol: BRIDGE_PROTOCOL_VERSION,
      role: 'extension',
      ...options,
    };
  }

  get status(): BridgeStatus {
    return this._status;
  }

  get connected(): boolean {
    return this._status === 'open';
  }

  /** Start connecting (and keep reconnecting). Safe to call repeatedly. */
  connect(): void {
    this.shouldReconnect = true;
    if (this._status === 'connecting' || this._status === 'handshaking' || this._status === 'open') return;
    this.openSocket();
  }

  /** Stop reconnecting and close the socket. */
  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearHandshakeTimer();
    this.rejectAll(new Error('Bridge disconnected'));
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.socket = null;
    this.setStatus('closed');
  }

  /** Send a method request to the desktop companion. */
  request<M extends BridgeMethod>(
    method: M,
    params: MethodParams[M],
    timeoutMs?: number,
  ): Promise<MethodResults[M]> {
    return new Promise<MethodResults[M]>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== 1 /* OPEN */ || this._status !== 'open') {
        reject(new Error('Bridge is not connected to the desktop companion'));
        return;
      }
      const id = randomId();
      const timeout = timeoutMs ?? this.options.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge request "${method}" timed out`));
      }, timeout);

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const message: BridgeRequest<M> = { kind: 'request', id, method, params };
      this.send(message);
    });
  }

  // --- internals ----------------------------------------------------------

  private openSocket(): void {
    const WebSocketImpl = this.options.websocket ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    if (!WebSocketImpl) {
      this.options.onError?.(new Error('WebSocket is not available in this environment'));
      return;
    }

    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(this.options.url);
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.setStatus('handshaking');
      this.send({
        kind: 'hello',
        protocol: this.options.protocol,
        token: this.options.token,
        role: this.options.role,
      });
      this.handshakeTimer = setTimeout(() => {
        this.options.onError?.(new Error('Bridge handshake timed out'));
        this.closeSocket();
      }, this.options.handshakeTimeoutMs);
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    socket.onerror = (event: Event) => {
      this.options.onError?.(event);
    };

    socket.onclose = () => {
      this.clearHandshakeTimer();
      this.rejectAll(new Error('Bridge connection closed'));
      this.socket = null;
      this.setStatus('closed');
      if (this.shouldReconnect) this.scheduleReconnect();
    };
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: BridgeMessage;
    try {
      message = JSON.parse(data) as BridgeMessage;
    } catch {
      this.options.onError?.(new Error('Bridge received malformed JSON'));
      return;
    }

    switch (message.kind) {
      case 'welcome': {
        this.clearHandshakeTimer();
        if (!message.ok) {
          this.options.onError?.(new Error('Desktop companion rejected the handshake'));
          this.closeSocket();
          return;
        }
        this.reconnectAttempt = 0;
        this.setStatus('open');
        break;
      }
      case 'response': {
        if (!isBridgeResponse(message)) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error));
        break;
      }
      case 'event': {
        if (!isBridgeEvent(message)) return;
        this.options.onEvent?.(message);
        break;
      }
      case 'error': {
        this.options.onError?.(new Error(`${message.code}: ${message.message}`));
        break;
      }
      default:
        break;
    }
  }

  private send(message: BridgeMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 /* OPEN */) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private closeSocket(): void {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.setStatus('closed');
    if (this.shouldReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.setStatus('reconnecting');
    const { minDelayMs, maxDelayMs } = this.options;
    const base = Math.min(maxDelayMs, minDelayMs * 2 ** this.reconnectAttempt);
    const jitter = Math.random() * base * 0.3;
    const delay = Math.round(base + jitter);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private setStatus(status: BridgeStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.options.onStatusChange?.(status);
  }
}
