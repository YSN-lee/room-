import type { AudioFrame, Room, RemoteTrack, RemoteTrackPublication } from '@livekit/rtc-node' with { 'resolution-mode': 'import' };
import { TranscriptBuffer, type Recognition, type Segment } from './transcript-buffer.js';
import { TranscriptionAdapter, type OpenRecognizer } from './transcription-adapter.js';

const PCM_BYTES_PER_MS = 32;
const COVERAGE_TOLERANCE_MS = 1500;

type Coverage = { startMs?: number; bytes: number };
type TimedFrame = { frame: ReadableStreamReadResult<AudioFrame>; receivedAt: number };

/** Owns the RTC and ASR resources for one active session. */
export class LiveKitTranscription {
  readonly buffer: TranscriptBuffer;
  private readonly adapter: TranscriptionAdapter;
  private readonly tracks = new Map<string, { owner: string; track: RemoteTrack; stop: () => void }>();
  private readonly coverage = new Map<string, Coverage>();
  private readonly deadline: ReturnType<typeof setTimeout>;
  private room?: Room;
  private expiry?: ReturnType<typeof setTimeout>;
  private closing = false;
  private deadlineMs: number;

  constructor(id: string, private readonly members: readonly string[],
    private readonly startedAt: number, private readonly endsAt: number,
    private readonly open: OpenRecognizer, publish: (segment: Segment) => void, private readonly onExpiry: () => void) {
    this.deadlineMs = endsAt;
    this.buffer = new TranscriptBuffer(id, members, endsAt - startedAt);
    this.adapter = new TranscriptionAdapter(this.buffer, open, publish);
    this.deadline = setTimeout(() => { void this.finish(endsAt); }, Math.max(0, endsAt - Date.now()));
    this.deadline.unref();
  }

  get active() { return !this.closing && Date.now() < this.deadlineMs; }

  get degraded() {
    return !this.buffer.captureComplete || (Date.now() - this.startedAt > COVERAGE_TOLERANCE_MS &&
      this.members.some(member => this.coverage.get(member)?.startMs === undefined));
  }

  async connect(url: string, token: () => Promise<string>) {
    try {
      const rtc = await import('@livekit/rtc-node');
      const credential = await token();
      if (this.closing) return;
      const room = new rtc.Room();
      this.room = room;
      const subscribe = (publication: RemoteTrackPublication, identity: string) => {
        if (this.active && this.members.includes(identity) &&
            publication.kind === rtc.TrackKind.KIND_AUDIO && publication.source === rtc.TrackSource.SOURCE_MICROPHONE) {
          try { publication.setSubscribed(true); } catch { this.buffer.markGap(); }
        }
      };
      room.on(rtc.RoomEvent.TrackPublished, (publication, participant) => subscribe(publication, participant.identity));
      room.on(rtc.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        const trackId = publication.sid;
        if (!trackId || !this.active || !this.members.includes(participant.identity) ||
            publication.source !== rtc.TrackSource.SOURCE_MICROPHONE ||
            !(track instanceof rtc.RemoteAudioTrack) || this.tracks.has(trackId)) return;
        if ([...this.tracks.values()].some(entry => entry.owner === participant.identity)) {
          this.buffer.markGap();
          try { publication.setSubscribed(false); } catch { this.buffer.markGap(); }
          return;
        }
        let reader: ReadableStreamDefaultReader<AudioFrame>;
        try {
          reader = new rtc.AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 }).getReader();
        } catch {
          this.buffer.markGap();
          return;
        }
        const stop = () => { void reader.cancel().catch(() => this.buffer.markGap()); };
        const entry = { owner: participant.identity, track, stop };
        this.tracks.set(trackId, entry);
        const first = reader.read().then(frame => ({ frame, receivedAt: Date.now() }), () => null);
        const coverage: Coverage = { bytes: 0 };
        if (this.coverage.has(participant.identity)) this.buffer.markGap();
        this.coverage.set(participant.identity, coverage);
        const open: OpenRecognizer = (receive, signal, fail) => this.open(value => {
          // The recognizer validates its own relative times. The PCM clock is
          // anchored to the server's receipt of the first frame for this track.
          const line = value as Recognition;
          const offset = coverage.startMs ?? 0;
          receive({ ...line, startMs: offset + line.startMs, endMs: offset + line.endMs });
        }, signal, fail);
        void this.adapter.consume({
          trackId, ownerIdentity: participant.identity, source: 'microphone',
          frames: this.frames(reader, coverage, first), stopFrames: stop,
        }, open).finally(() => {
          stop();
          if (this.tracks.get(trackId) === entry) this.tracks.delete(trackId);
        });
      });
      room.on(rtc.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        const id = publication.sid;
        const entry = id && this.tracks.get(id);
        if (id && entry && entry.track === track && this.active) {
          this.tracks.delete(id);
          this.adapter.cancel(id);
          entry.stop();
          for (const candidate of participant.trackPublications.values()) {
            if (candidate.sid !== id) subscribe(candidate, participant.identity);
          }
        }
      });
      room.on(rtc.RoomEvent.TrackSubscriptionFailed, (_sid, participant) => {
        if (this.members.includes(participant.identity)) this.buffer.markGap();
      });
      room.on(rtc.RoomEvent.Reconnecting, () => this.buffer.markGap());
      room.on(rtc.RoomEvent.Disconnected, () => {
        if (!this.closing) {
          this.buffer.markGap();
          for (const [id, entry] of this.tracks) {
            this.adapter.cancel(id);
            entry.stop();
          }
          this.tracks.clear();
        }
      });
      await room.connect(url, credential, { autoSubscribe: false, dynacast: false });
      if (this.closing) {
        await room.disconnect();
        return;
      }
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) subscribe(publication, participant.identity);
      }
    } catch {
      this.buffer.markGap();
    }
  }

  private async *frames(reader: ReadableStreamDefaultReader<AudioFrame>, coverage: Coverage,
    first: Promise<TimedFrame | null>) {
    let initial = true;
    while (!this.closing) {
      const item = initial ? await first : { frame: await reader.read(), receivedAt: Date.now() };
      initial = false;
      if (!item) throw new Error('RTC frame read failed');
      const { value, done } = item.frame;
      const now = Date.now();
      if (done || this.closing) return;
      if (now >= this.deadlineMs) {
        void this.finish(this.deadlineMs);
        return;
      }
      const pcm = value.data;
      const relative = now - this.startedAt;
      coverage.startMs ??= Math.max(0, Math.round(item.receivedAt - this.startedAt - pcm.byteLength / PCM_BYTES_PER_MS));
      const remaining = (this.deadlineMs - this.startedAt - coverage.startMs) * PCM_BYTES_PER_MS - coverage.bytes;
      const length = Math.min(remaining, pcm.byteLength);
      if (length <= 0) return;
      coverage.bytes += length;
      if (Math.abs(coverage.startMs + coverage.bytes / PCM_BYTES_PER_MS - relative) > COVERAGE_TOLERANCE_MS) {
        this.buffer.markGap();
      }
      yield new Uint8Array(pcm.buffer, pcm.byteOffset, length);
    }
  }

  private finishing?: Promise<void>;
  finish(endedAt: number): Promise<void> {
    if (this.finishing) {
      if (endedAt >= this.deadlineMs) return this.finishing;
      this.deadlineMs = endedAt;
      return this.finishing.then(() => this.buffer.freeze(Math.max(0, endedAt - this.startedAt)));
    }
    this.closing = true;
    clearTimeout(this.deadline);
    this.deadlineMs = Math.min(endedAt, this.endsAt);
    this.expiry = setTimeout(() => {
      this.dispose();
      this.onExpiry();
    }, Math.max(0, this.deadlineMs + 300000 - Date.now()));
    this.expiry.unref();
    const duration = this.deadlineMs - this.startedAt;
    for (const id of this.members) {
      const track = this.coverage.get(id);
      if (track?.startMs === undefined || track.startMs > COVERAGE_TOLERANCE_MS ||
          track.startMs + track.bytes / PCM_BYTES_PER_MS < duration - COVERAGE_TOLERANCE_MS) {
        this.buffer.markGap();
      }
    }
    this.finishing = this.adapter.drain(Math.max(0, duration)).finally(() => this.disconnect());
    return this.finishing;
  }

  dispose() {
    this.closing = true;
    clearTimeout(this.deadline);
    clearTimeout(this.expiry);
    this.adapter.stop();
    this.disconnect();
  }

  private disconnect() {
    for (const entry of this.tracks.values()) entry.stop();
    this.tracks.clear();
    const room = this.room;
    this.room = undefined;
    void room?.disconnect().catch(() => this.buffer.markGap());
  }
}
