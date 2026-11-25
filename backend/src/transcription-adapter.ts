import { setTimeout as delay } from 'node:timers/promises';
import { TranscriptBuffer, type Segment } from './transcript-buffer.js';

/** The RTC transport supplies authenticated publication metadata and cancels blocked reads. */
export interface AudioPublication {
  trackId: string;
  ownerIdentity: string;
  source: 'microphone' | 'other';
  frames: AsyncIterable<Uint8Array>;
  stopFrames?: () => void;
}
export interface Recognizer {
  write(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export type OpenRecognizer = (
  receive: (result: unknown) => void,
  signal: AbortSignal,
  onFailure: () => void,
) => Promise<Recognizer>;

type Job = { owner: string; controller: AbortController; stopFrames?: () => void; done: Promise<void> };

/** One PCM16 mono 16 kHz recognizer per authenticated microphone. */
export class TranscriptionAdapter {
  private readonly jobs = new Map<string, Job>();
  private phase: 'active' | 'draining' | 'stopped' = 'active';
  private drainTask?: Promise<void>;

  constructor(private readonly buffer: TranscriptBuffer, private readonly open: OpenRecognizer,
    private readonly publish: (segment: Segment) => void) {}

  consume(publication: AudioPublication, open = this.open): Promise<void> {
    if (this.phase !== 'active' || publication.source !== 'microphone') return Promise.resolve();
    if (this.jobs.has(publication.trackId)) return Promise.resolve();
    if (this.jobs.size >= 2 || [...this.jobs.values()].some(job => job.owner === publication.ownerIdentity)) {
      this.buffer.markGap();
      return Promise.resolve();
    }
    const accept = this.buffer.bindTrack(publication.trackId, publication.ownerIdentity);
    if (!accept) return Promise.resolve();
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      const stopFrames = () => publication.stopFrames?.();
      const fail = () => {
        this.buffer.markGap();
        controller.abort();
      };
      const signal = controller.signal;
      signal.addEventListener('abort', stopFrames, { once: true });
      try {
        signal.throwIfAborted();
        const recognizer = await open(result => {
          if (signal.aborted) return;
          const segment = accept(result);
          if (segment) this.publish(segment);
        }, signal, fail);
        for await (const frame of publication.frames) {
          if (signal.aborted || this.phase !== 'active') break;
          if (!(frame instanceof Uint8Array) || !frame.length || frame.length > 64000 || frame.length % 2 !== 0) {
            throw new Error('Invalid PCM frame');
          }
          await recognizer.write(frame);
        }
        if (this.phase === 'active') this.buffer.markGap();
        if (!signal.aborted) {
          const deadline = setTimeout(fail, 5000);
          try { await recognizer.close(); } finally { clearTimeout(deadline); }
        }
      } catch {
        this.buffer.markGap();
      } finally {
        controller.abort();
        if (this.jobs.get(publication.trackId)?.controller === controller) {
          this.jobs.delete(publication.trackId);
          this.buffer.unbindTrack(publication.trackId, this.phase !== 'active');
        }
      }
    });
    this.jobs.set(publication.trackId, { owner: publication.ownerIdentity, controller, stopFrames: publication.stopFrames, done });
    return done;
  }

  cancel(trackId: string): void {
    const job = this.jobs.get(trackId);
    if (!job) return;
    this.jobs.delete(trackId);
    this.buffer.unbindTrack(trackId);
    job.controller.abort();
  }

  drain(endMs = this.buffer.durationMs): Promise<void> {
    if (this.drainTask) return this.drainTask;
    if (this.phase !== 'active') return Promise.resolve();
    this.phase = 'draining';
    for (const job of this.jobs.values()) job.stopFrames?.();
    const timeout = new AbortController();
    this.drainTask = Promise.race([
      Promise.all([...this.jobs.values()].map(job => job.done)),
      delay(5000, undefined, { signal: timeout.signal, ref: false }).then(() => {
        this.buffer.markGap();
        this.abortJobs();
      }),
    ]).then(() => this.buffer.freeze(endMs)).finally(() => timeout.abort());
    return this.drainTask;
  }

  private abortJobs() {
    for (const job of this.jobs.values()) job.controller.abort();
  }

  stop() {
    this.phase = 'stopped';
    this.abortJobs();
    this.buffer.purge();
  }
}
