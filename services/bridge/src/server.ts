/**
 * Diggy local bridge server.
 *
 * A tiny, localhost-only WebSocket + HTTP server that the browser extension
 * (and any future desktop companion) talks to. It speaks the `@diggy/shared`
 * protocol:
 *
 *   client → `{ kind: 'hello', protocol, token, role }`
 *   server → `{ kind: 'welcome', protocol, ok: true }`
 *
 * Requests arriving as `{ kind: 'request', id, method, params }` are answered
 * with a correlated `{ kind: 'response', id, method, ok, result | error }`.
 * A handful of methods are implemented here by forwarding to the local crawler
 * service; the rest are owned by the desktop host and are reported as unknown.
 *
 * The server binds `127.0.0.1` only and refuses connections without the shared
 * token, so nothing on the network can reach it.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  BRIDGE_PORT,
  BRIDGE_PROTOCOL_VERSION,
  CRAWLER_DEFAULT_URL,
  isBridgeRequest,
  type BridgeEvent,
  type BridgeMessage,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type HelloMessage,
  type MethodParams,
  type MethodResults,
} from '@diggy/shared';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

/** Default loopback host — the bridge is never exposed beyond this machine. */
const DEFAULT_HOST = '127.0.0.1';
/** How long a freshly-opened socket has to send its `hello`. */
const HANDSHAKE_TIMEOUT_MS = 6_000;
/** Upper bound for a crawler round-trip before we give up and fail the request. */
const CRAWLER_TIMEOUT_MS = 15_000;

export interface BridgeServerOptions {
  /** TCP port to listen on. `0` picks an ephemeral port (handy in tests). */
  port?: number;
  /** Shared secret clients must present in their `hello`. */
  token?: string;
  /** Interface to bind. Defaults to loopback only. */
  host?: string;
  /** Base URL of the local crawler service used to satisfy crawl/searchWeb. */
  crawlerUrl?: string;
  /** Sink for human-readable lifecycle logs. Defaults to `console.log`. */
  log?: (message: string) => void;
}

export interface BridgeServerHandle {
  /** The actually-bound port (resolved even when `port: 0` was requested). */
  readonly port: number;
  /** The token clients must present. Generated when none was configured. */
  readonly token: string;
  /** Whether the token was generated at startup rather than configured. */
  readonly tokenGenerated: boolean;
  /** `ws://host:port` — the address the extension connects to. */
  readonly url: string;
  /** Normalised crawler base URL this bridge forwards to. */
  readonly crawlerUrl: string;
  /** Number of currently connected sockets. */
  readonly clients: number;
  /** Push a `BridgeEvent` to every authenticated client. */
  broadcast(event: BridgeEvent): void;
  /** Stop accepting connections, drop clients and release the port. */
  close(): Promise<void>;
}

/** Turn a `ws` raw frame into a UTF-8 string. */
function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * Create, bind and return a running bridge server.
 *
 * Resolves once the HTTP/WebSocket listener is accepting connections, so the
 * returned `port` is always the real one — including when `port: 0` is used.
 */
export async function createBridgeServer(
  options: BridgeServerOptions = {},
): Promise<BridgeServerHandle> {
  const log = options.log ?? ((message: string) => console.log(`[bridge] ${message}`));

  const configuredPort =
    options.port ?? (process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : BRIDGE_PORT);
  const port = Number.isFinite(configuredPort) ? configuredPort : BRIDGE_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const crawlerUrl = (options.crawlerUrl ?? process.env.CRAWLER_URL ?? CRAWLER_DEFAULT_URL).replace(
    /\/+$/,
    '',
  );

  const configuredToken = options.token ?? process.env.DIGGY_BRIDGE_TOKEN ?? '';
  const tokenGenerated = configuredToken.length === 0;
  const token = tokenGenerated ? randomBytes(24).toString('hex') : configuredToken;
  if (tokenGenerated) {
    log('No token configured (DIGGY_BRIDGE_TOKEN) — generated a random one for this run.');
    log(`token=${token}`);
  }

  /** Sockets that have completed the handshake and may receive broadcasts. */
  const authenticated = new WeakSet<WebSocket>();

  const sendMessage = (socket: WebSocket, message: BridgeMessage): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      log(`failed to send to client: ${(error as Error).message}`);
    }
  };

  const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CRAWLER_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const crawlCrawler = async (
    baseUrl: string,
    params: MethodParams['crawl'],
  ): Promise<MethodResults['crawl']> => {
    const response = await fetchWithTimeout(`${baseUrl}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    });
    if (!response.ok) throw new Error(`crawler /crawl responded ${response.status}`);
    return (await response.json()) as MethodResults['crawl'];
  };

  const searchCrawler = async (
    baseUrl: string,
    params: MethodParams['searchWeb'],
  ): Promise<MethodResults['searchWeb']> => {
    const query = params?.query ?? '';
    const response = await fetchWithTimeout(`${baseUrl}/search?q=${encodeURIComponent(query)}`, {
      method: 'GET',
    });
    if (!response.ok) throw new Error(`crawler /search responded ${response.status}`);
    return (await response.json()) as MethodResults['searchWeb'];
  };

  const dispatch = async (method: BridgeMethod, params: unknown): Promise<unknown> => {
    switch (method) {
      case 'crawl':
        return crawlCrawler(crawlerUrl, params as MethodParams['crawl']);
      case 'searchWeb':
        return searchCrawler(crawlerUrl, params as MethodParams['searchWeb']);
      case 'notify': {
        const payload = params as MethodParams['notify'];
        log(`notify: ${payload.title}${payload.body ? ` — ${payload.body}` : ''}`);
        return undefined;
      }
      case 'speak': {
        const payload = params as MethodParams['speak'];
        log(`speak: ${payload.text}`);
        return undefined;
      }
      default:
        // readPage/fillForm/… are handled by the desktop host, not the bridge.
        throw new Error(`Unknown method: ${String(method)}`);
    }
  };

  const handleRequest = async (socket: WebSocket, request: BridgeRequest): Promise<void> => {
    try {
      const result = await dispatch(request.method, request.params);
      const response: BridgeResponse = {
        kind: 'response',
        id: request.id,
        method: request.method,
        ok: true,
        result: result as MethodResults[typeof request.method],
      };
      sendMessage(socket, response);
    } catch (error) {
      const response: BridgeResponse = {
        kind: 'response',
        id: request.id,
        method: request.method,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      sendMessage(socket, response);
    }
  };

  const broadcast = (event: BridgeEvent): void => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && authenticated.has(client)) {
        try {
          client.send(payload);
        } catch (error) {
          log(`broadcast failed: ${(error as Error).message}`);
        }
      }
    }
  };

  // A server without its own listener: upgrades are handled from the HTTP server
  // so the WebSocket shares the one loopback-bound port as `/health`.
  const wss = new WebSocketServer({ noServer: true });

  const httpServer: Server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (request.method === 'GET' && (url === '/health' || url === '/health/')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({ status: 'ok', service: '@diggy/bridge', clients: wss.clients.size }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  httpServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', (socket, request) => {
    const remote = request.socket.remoteAddress ?? 'unknown';
    log(`client connected from ${remote}`);

    let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      helloTimer = null;
      if (!authenticated.has(socket)) {
        sendMessage(socket, { kind: 'error', code: 'unauthorized', message: 'Handshake timeout' });
        socket.close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const clearHelloTimer = (): void => {
      if (helloTimer) {
        clearTimeout(helloTimer);
        helloTimer = null;
      }
    };

    const completeHandshake = (hello: HelloMessage): void => {
      if (hello.token !== token) {
        sendMessage(socket, { kind: 'error', code: 'unauthorized', message: 'Bad token' });
        socket.close();
        return;
      }
      clearHelloTimer();
      authenticated.add(socket);
      sendMessage(socket, { kind: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, ok: true });
      log(`client authenticated (role=${hello.role})`);
    };

    socket.on('message', (data) => {
      let message: BridgeMessage;
      try {
        message = JSON.parse(rawDataToText(data)) as BridgeMessage;
      } catch {
        sendMessage(socket, { kind: 'error', code: 'bad_message', message: 'Malformed JSON' });
        return;
      }

      if (!authenticated.has(socket)) {
        if (message.kind !== 'hello') {
          sendMessage(socket, {
            kind: 'error',
            code: 'expected_hello',
            message: 'First message must be a hello',
          });
          socket.close();
          return;
        }
        completeHandshake(message as HelloMessage);
        return;
      }

      if (isBridgeRequest(message)) {
        void handleRequest(socket, message);
      }
    });

    socket.on('close', (code) => {
      clearHelloTimer();
      authenticated.delete(socket);
      log(`client disconnected from ${remote} (code ${code})`);
    });

    socket.on('error', (error) => {
      log(`client error from ${remote}: ${error.message}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort =
    typeof address === 'object' && address !== null ? (address as AddressInfo).port : port;
  log(`listening on ws://${host}:${boundPort} (health http://${host}:${boundPort}/health)`);
  log(`forwarding crawl/searchWeb to ${crawlerUrl}`);

  const close = async (): Promise<void> => {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    log('stopped');
  };

  return {
    port: boundPort,
    token,
    tokenGenerated,
    url: `ws://${host}:${boundPort}`,
    crawlerUrl,
    get clients(): number {
      return wss.clients.size;
    },
    broadcast,
    close,
  };
}
