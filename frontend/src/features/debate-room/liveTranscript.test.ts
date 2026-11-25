import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeTranscript } from './liveTranscript';

class Socket {
  static all: Socket[] = [];
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  close = vi.fn((code = 1000) => this.onclose?.({ code }));
  constructor() { Socket.all.push(this); }
  event(type: string, sequence: number, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ session_id: 'room', sequence, type, payload }) });
  }
}

const session = (state = 'active') => ({ session: { state, transcriptStatus: 'capturing' } });
const line = (text: string, revision: number, isFinal: boolean) => ({
  sessionId: 'room', segmentId: 'line', participantId: 'speaker', attributionStatus: 'verified',
  startMs: 0, endMs: 10, text, revision, isFinal,
});

function arrange() {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  let respond!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const update = vi.fn();
  const stop = subscribeTranscript('room', 'test-token', update);
  const receiveSnapshot = () => respond(new Response(JSON.stringify({
    sequence: 1, status: 'capturing', segments: [line('partial', 0, false)],
  })));
  return { stop, update, fetch, ws: Socket.all[0]!, receiveSnapshot };
}

afterEach(() => {
  Socket.all = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live transcript client', () => {
  it('authenticates, merges events after the snapshot watermark, and protects finalized text', async () => {
    const { ws, stop, update, receiveSnapshot } = arrange();
    ws.onopen?.();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ authorization: 'Bearer test-token', session_id: 'room' }));
    ws.event('session.state', 1, session());
    ws.event('transcript.segment', 2, line('final', 1, true));
    receiveSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    ws.event('transcript.segment', 3, line('late partial', 2, false));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      segments: [expect.objectContaining({ text: 'final', participantId: 'speaker' })],
    }));
    stop();
  });

  it('clears on a sequence gap and reconnects with a fresh snapshot', async () => {
    const { ws, stop, update, fetch, receiveSnapshot } = arrange();
    ws.event('session.state', 1, session());
    receiveSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    ws.event('transcript.segment', 3, line('gap', 1, true));
    expect(update).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(500);
    Socket.all[1]?.event('session.state', 4, session());
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('aborts a pending snapshot and prevents late text after terminal state', async () => {
    const { ws, update, receiveSnapshot } = arrange();
    ws.event('session.state', 1, session());
    ws.event('session.state', 2, session('finishing'));
    receiveSnapshot();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(update.mock.calls).toEqual([[null]]);
    expect(Socket.all).toHaveLength(1);
  });
  it('drops the transcript when navigating away and reloads it when the page returns', async () => {
    const { ws, stop, update, fetch, receiveSnapshot } = arrange();
    ws.event('session.state', 1, session());
    receiveSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('pagehide'));
    expect(update).toHaveBeenLastCalledWith(null);
    expect(ws.close).toHaveBeenCalled();
    window.dispatchEvent(new Event('pageshow'));
    Socket.all[1]?.event('session.state', 4, session());
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('drops a pending response after authenticated view unmount', async () => {
    const { ws, stop, update, receiveSnapshot } = arrange();
    ws.event('session.state', 1, session());
    stop();
    receiveSnapshot();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(update).not.toHaveBeenCalled();
    expect(Socket.all).toHaveLength(1);
  });
});
