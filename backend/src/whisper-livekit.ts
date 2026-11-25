import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import type { OpenRecognizer } from './transcription-adapter.js';

const TIMESTAMP_TOLERANCE_MS = 100;

const result = z.object({
  type: z.literal('Results'),
  start: z.number().nonnegative(),
  duration: z.number().nonnegative(),
  is_final: z.literal(true),
  channel: z.object({ alternatives: z.tuple([z.object({ transcript: z.string() })]) }),
});

/** WhisperLiveKit 0.2.26 Deepgram-compatible PCM endpoint. */
export function whisperLiveKit(base: string): OpenRecognizer {
  const url = new URL('/v1/listen', base);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('WHISPERLIVEKIT_URL must be a WebSocket URL without credentials');
  }
  url.search = new URLSearchParams({
    encoding: 'linear16', sample_rate: '16000', channels: '1',
    interim_results: 'false', endpointing: 'false',
  }).toString();

  return async (receive, signal, onFailure) => {
    signal.throwIfAborted();
    const socket = new WebSocket(url, { handshakeTimeout: 3000, maxPayload: 262144, perMessageDeflate: false });
    const abort = () => socket.terminate();
    signal.addEventListener('abort', abort, { once: true });

    let closing = false;
    let ready = false;
    let summary = false;
    let failed = false;
    const fail = () => {
      if (failed || signal.aborted) return;
      failed = true;
      onFailure();
      socket.terminate();
    };
    const finished = new Promise<boolean>(resolve => {
      socket.on('error', fail);
      socket.once('close', code => {
        signal.removeEventListener('abort', abort);
        const drained = closing && summary && !failed && code === 1000;
        if (!drained) fail();
        resolve(drained);
      });
    });
    let audioMs = 0;
    let lastEnd = 0;
    let markReady!: () => void;
    const startup = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      void finished.then(() => reject(new Error('ASR connection closed')));
    });
    const startupTimer = setTimeout(fail, 3000);
    socket.on('message', (data, binary) => {
      try {
        if (binary) throw new Error();
        const message = JSON.parse(data.toString());
        if (message.type === 'Metadata') {
          const duration = z.number().nonnegative().parse(message.duration);
          if (!ready && duration === 0) {
            ready = true;
            markReady();
          } else if (closing && ready && Math.abs(duration * 1000 - audioMs) <= 1) {
            summary = true;
          } else {
            throw new Error();
          }
          return;
        }
        if (!ready || summary) throw new Error();
        const payload = result.parse(message);
        const words = payload.channel.alternatives[0].transcript.trim();
        if (!words) return;
        const reportedStart = Math.round(payload.start * 1000);
        const endMs = Math.round((payload.start + payload.duration) * 1000);
        // LocalAgreement can shift a newly committed word back across the previous boundary.
        if (reportedStart < lastEnd - TIMESTAMP_TOLERANCE_MS || endMs < lastEnd ||
            endMs > audioMs + TIMESTAMP_TOLERANCE_MS || reportedStart > audioMs) throw new Error();
        const startMs = Math.max(lastEnd, reportedStart);
        lastEnd = Math.min(endMs, Math.floor(audioMs));
        receive({ segmentId: randomUUID(), revision: 0, startMs, endMs: lastEnd, text: words, isFinal: true });
      } catch {
        fail();
      }
    });

    try { await startup; } finally { clearTimeout(startupTimer); }
    return {
      async write(frame) {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + frame.byteLength > 64000) {
          fail();
          throw new Error('ASR stream unavailable');
        }
        audioMs += frame.byteLength / 32;
        // Enqueue synchronously. Waiting on a network callback per frame would allow
        // the RTC SDK's readable stream to accumulate unbounded audio.
        socket.send(frame, { binary: true }, error => { if (error) fail(); });
      },
      async close() {
        if (signal.aborted) return;
        if (socket.readyState !== WebSocket.OPEN) throw new Error('ASR stream unavailable');
        closing = true;
        socket.send(JSON.stringify({ type: 'CloseStream' }), error => { if (error) fail(); });
        if (!await finished) throw new Error('ASR drain incomplete');
      },
    };
  };
}
