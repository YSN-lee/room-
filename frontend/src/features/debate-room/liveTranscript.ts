import { API_URL } from '../../lib/config';
import { roomRequest, RoomApiError } from '../../lib/room-api';
import type { TranscriptSegment } from './types';

type View = { segments: TranscriptSegment[]; degraded: boolean };
type Snapshot = { sequence: number; segments: unknown[]; status: string };

function transcriptSegment(value: unknown, sessionId: string): TranscriptSegment {
  const line = value as Record<string, unknown> | null;
  if (!line || line.sessionId !== sessionId || typeof line.segmentId !== 'string' ||
      typeof line.participantId !== 'string' || line.attributionStatus !== 'verified' ||
      typeof line.revision !== 'number' || !Number.isSafeInteger(line.revision) || line.revision < 0 ||
      typeof line.startMs !== 'number' || typeof line.endMs !== 'number' ||
      !Number.isSafeInteger(line.startMs) || !Number.isSafeInteger(line.endMs) ||
      line.startMs < 0 || line.endMs < line.startMs || line.endMs > 1_800_000 ||
      typeof line.text !== 'string' || line.text.length > 4000 || typeof line.isFinal !== 'boolean') {
    throw new Error('Invalid transcript segment');
  }
  const { segmentId, participantId, revision, startMs, endMs, text, isFinal } = line;
  return { segmentId, participantId, revision, startMs, endMs, text, isFinal };
}

/** Attaches the transcript panel to authenticated room events. All text is held in memory. */
export function subscribeTranscript(sessionId: string, accessToken: string, update: (view: View | null) => void) {
  const url = new URL(`${API_URL}/api/events`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket | undefined;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let clearConnection: (() => void) | undefined;
  let stopped = false;
  let suspended = false;
  let backoffMs = 500;

  function clear() {
    clearConnection?.();
    clearTimeout(retry);
    controller?.abort();
    socket?.close();
  }

  function stop() {
    stopped = true;
    window.removeEventListener('pagehide', suspend);
    window.removeEventListener('pageshow', resume);
    clear();
  }

  function suspend() {
    suspended = true;
    clear();
    update(null);
  }

  function resume() {
    if (!suspended || stopped) return;
    suspended = false;
    connect();
  }

  function connect() {
    if (stopped || suspended) return;
    const ws = new WebSocket(url);
    const request = new AbortController();
    socket = ws;
    controller = request;
    const segments = new Map<string, TranscriptSegment>();
    const pending: { sequence: number; line: TranscriptSegment }[] = [];
    const discard = () => {
      segments.clear();
      pending.length = 0;
    };
    clearConnection = discard;
    let lastSequence: number | undefined;
    let watermark: number | undefined;
    let started = false;
    let degraded = false;
    const resync = () => {
      request.abort();
      discard();
      update(null);
      ws.close(4000);
    };
    const timeout = setTimeout(resync, 10_000);
    request.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
    const current = () => !stopped && !request.signal.aborted;
    const merge = (line: TranscriptSegment) => {
      const old = segments.get(line.segmentId);
      if (old && (old.isFinal || line.revision <= old.revision)) return;
      if (!old && segments.size >= 4096) throw new Error('Transcript limit reached');
      segments.set(line.segmentId, line);
    };
    const publish = () => update({
      segments: [...segments.values()].sort((a, b) => a.startMs - b.startMs || a.segmentId.localeCompare(b.segmentId)),
      degraded,
    });

    async function loadSnapshot() {
      try {
        const snapshot = await roomRequest<Snapshot>(accessToken, `/sessions/${encodeURIComponent(sessionId)}/transcript`,
          'GET', undefined, request.signal);
        if (!current()) return;
        if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 ||
            !Array.isArray(snapshot.segments) || snapshot.segments.length > 4096) throw new Error('Invalid transcript snapshot');
        for (const line of snapshot.segments) merge(transcriptSegment(line, sessionId));
        watermark = snapshot.sequence;
        for (const event of pending) if (event.sequence > watermark) merge(event.line);
        pending.length = 0;
        degraded ||= snapshot.status !== 'capturing';
        clearTimeout(timeout);
        backoffMs = 500;
        publish();
      } catch (error) {
        if (!current()) return;
        if (error instanceof RoomApiError && [401, 403, 404, 409].includes(error.status)) {
          stop();
          update(null);
        } else {
          resync();
        }
      }
    }

    ws.onopen = () => {
      if (current()) ws.send(JSON.stringify({ authorization: `Bearer ${accessToken}`, session_id: sessionId }));
    };
    ws.onmessage = ({ data }) => {
      if (!current()) return;
      try {
        const event = JSON.parse(data);
        if (event.session_id !== sessionId || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return;
        if (lastSequence !== undefined && event.sequence <= lastSequence) return;
        if (event.type === 'session.state' && event.payload.session.state !== 'active') {
          stop();
          update(null);
          return;
        }
        if (lastSequence !== undefined && event.sequence !== lastSequence + 1) {
          resync();
          return;
        }
        lastSequence = event.sequence;
        if (event.type === 'session.state') {
          const status = event.payload.session.transcriptStatus;
          const nextDegraded = typeof status === 'string' ? status !== 'capturing' : degraded;
          const changed = degraded !== nextDegraded;
          degraded = nextDegraded;
          if (!started) {
            started = true;
            void loadSnapshot();
          } else if (watermark !== undefined && changed) publish();
        } else if (event.type === 'transcript.segment' && started) {
          const line = transcriptSegment(event.payload, sessionId);
          if (watermark === undefined) {
            if (pending.length >= 64) throw new Error('Snapshot catch-up limit reached');
            pending.push({ sequence: event.sequence, line });
          } else if (event.sequence > watermark) {
            merge(line);
            publish();
          }
        }
      } catch {
        resync();
      }
    };
    ws.onerror = () => { if (current()) resync(); };
    ws.onclose = ({ code }) => {
      request.abort();
      discard();
      if (stopped || suspended || socket !== ws) return;
      update(null);
      if (code === 1008) return;
      retry = setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 8000);
    };
  }

  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
  connect();
  return stop;
}
