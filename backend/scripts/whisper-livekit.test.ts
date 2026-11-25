import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { whisperLiveKit } from '../src/whisper-livekit.js';

async function withProvider(run: (server: WebSocketServer, url: string) => Promise<void>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  try {
    await run(server, `ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('WhisperLiveKit streaming transport', () => {
  it('sends mono PCM and receives final speech during a successful drain', () => withProvider(async (server, url) => {
    const received = vi.fn();
    const failed = vi.fn();
    server.on('connection', (ws, request) => {
      const endpoint = new URL(request.url!, url);
      expect(endpoint.pathname).toBe('/v1/listen');
      expect(Object.fromEntries(endpoint.searchParams)).toEqual({
        encoding: 'linear16', sample_rate: '16000', channels: '1',
        interim_results: 'false', endpointing: 'false',
      });
      ws.send(JSON.stringify({ type: 'Metadata', duration: 0 }));
      ws.on('message', (data, binary) => {
        if (binary) {
          expect(data).toEqual(Buffer.alloc(640));
          return;
        }
        expect(JSON.parse(data.toString())).toEqual({ type: 'CloseStream' });
        ws.send(JSON.stringify({
          type: 'Results', start: 0, duration: 0.02, is_final: true,
          channel: { alternatives: [{ transcript: 'Hello', speaker: 'untrusted label' }] },
        }));
        ws.send(JSON.stringify({ type: 'Metadata', duration: 0.02 }));
        ws.close(1000);
      });
    });
    const stream = await whisperLiveKit(url)(received, new AbortController().signal, failed);
    await stream.write(Buffer.alloc(640));
    await stream.close();
    expect(received).toHaveBeenCalledExactlyOnceWith({
      segmentId: expect.any(String), revision: 0, startMs: 0, endMs: 20, text: 'Hello', isFinal: true,
    });
    expect(failed).not.toHaveBeenCalled();
  }));

  it('keeps both finals when LocalAgreement overlaps adjacent word boundaries', () => withProvider(async (server, url) => {
    const received = vi.fn();
    const failed = vi.fn();
    server.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'Metadata', duration: 0 }));
      ws.on('message', (_data, binary) => {
        if (binary) return;
        for (const [start, duration, transcript] of [[0, 0.64, 'City'], [0.62, 1.68, 'parks are open to everyone.']]) {
          ws.send(JSON.stringify({
            type: 'Results', start, duration, is_final: true, channel: { alternatives: [{ transcript }] },
          }));
        }
        ws.send(JSON.stringify({ type: 'Metadata', duration: 3 }));
        ws.close(1000);
      });
    });
    const stream = await whisperLiveKit(url)(received, new AbortController().signal, failed);
    for (let frame = 0; frame < 150; frame++) {
      await stream.write(Buffer.alloc(640));
      if (frame % 25 === 24) await new Promise<void>(resolve => setImmediate(resolve));
    }
    await stream.close();
    expect(received.mock.calls.map(([line]) => [line.startMs, line.endMs, line.text])).toEqual([
      [0, 640, 'City'], [640, 2300, 'parks are open to everyone.'],
    ]);
    expect(failed).not.toHaveBeenCalled();
  }));

  it('marks a normal transport close without the processed-audio summary as a failed drain', () => withProvider(async (server, url) => {
    const failed = vi.fn();
    server.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'Metadata', duration: 0 }));
      ws.once('message', () => ws.close(1000));
    });
    const stream = await whisperLiveKit(url)(vi.fn(), new AbortController().signal, failed);
    await expect(stream.close()).rejects.toThrow('ASR drain incomplete');
    expect(failed).toHaveBeenCalledOnce();
  }));
});
