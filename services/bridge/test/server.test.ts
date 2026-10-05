import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { BRIDGE_PROTOCOL_VERSION } from '@diggy/shared';
import { createBridgeServer, type BridgeServerHandle } from '../src/server.js';

const TOKEN = 'test-token';

const running: BridgeServerHandle[] = [];

async function startServer(): Promise<BridgeServerHandle> {
  const server = await createBridgeServer({ port: 0, token: TOKEN, log: () => {} });
  running.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function openSocket(server: BridgeServerHandle): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(rawToString(data))));
  });
}

function hello(token: string): string {
  return JSON.stringify({
    kind: 'hello',
    protocol: BRIDGE_PROTOCOL_VERSION,
    token,
    role: 'extension',
  });
}

describe('bridge handshake', () => {
  it('accepts a correct token with a welcome', async () => {
    const server = await startServer();
    const socket = await openSocket(server);

    socket.send(hello(TOKEN));
    const message = await nextMessage(socket);

    expect(message).toMatchObject({
      kind: 'welcome',
      protocol: BRIDGE_PROTOCOL_VERSION,
      ok: true,
    });

    socket.close();
  });

  it('rejects a wrong token with an unauthorized error and closes', async () => {
    const server = await startServer();
    const socket = await openSocket(server);

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.send(hello('not-the-token'));

    const message = await nextMessage(socket);
    expect(message).toMatchObject({
      kind: 'error',
      code: 'unauthorized',
      message: 'Bad token',
    });

    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('bridge HTTP health', () => {
  it('answers GET /health with the service identity and client count', async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', service: '@diggy/bridge' });
    expect(typeof body.clients).toBe('number');
  });

  it('404s on unknown paths', async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(response.status).toBe(404);
  });
});

describe('bridge requests', () => {
  it('reports unknown server-side methods as ok:false', async () => {
    const server = await startServer();
    const socket = await openSocket(server);
    socket.send(hello(TOKEN));
    await nextMessage(socket);

    socket.send(JSON.stringify({ kind: 'request', id: 'r1', method: 'setMood', params: { mood: 'happy' } }));
    const message = (await nextMessage(socket)) as Record<string, unknown>;

    expect(message).toMatchObject({ kind: 'response', id: 'r1', method: 'setMood', ok: false });
    expect(String(message.error)).toContain('Unknown method');

    socket.close();
  });

  it('broadcasts events to authenticated clients', async () => {
    const server = await startServer();
    const socket = await openSocket(server);
    socket.send(hello(TOKEN));
    await nextMessage(socket);

    server.broadcast({ kind: 'event', event: 'avatar', payload: { mood: 'happy' } });
    const message = await nextMessage(socket);

    expect(message).toMatchObject({
      kind: 'event',
      event: 'avatar',
      payload: { mood: 'happy' },
    });

    socket.close();
  });
});
