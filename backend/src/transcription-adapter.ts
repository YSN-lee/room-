import { TranscriptBuffer, type Segment } from './transcript-buffer.js';

/** Server-side RTC boundary. The implementation must supply authenticated publication metadata. */
export interface AudioPublication {
  trackId: string;
  ownerIdentity: string;
  source: 'microphone' | 'other';
  frames: AsyncIterable<Uint8Array>;
}
/** Each track gets a separate recognizer; frames are PCM16 mono 16 kHz. */
export interface Recognizer {
  write(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export type OpenRecognizer = (receive: (result: unknown) => void, signal: AbortSignal) => Promise<Recognizer>;

/** A transport-independent bridge core. No public HTTP endpoint or browser audio input. */
export class TranscriptionAdapter {
  private readonly jobs = new Map<string, AbortController>();
  private stopped = false;
  constructor(private readonly buffer: TranscriptBuffer, private readonly open: OpenRecognizer,
    private readonly publish: (segment: Segment) => void) {}
  async consume(publication: AudioPublication): Promise<void> {
    if (this.stopped || publication.source !== 'microphone') return;
    if (this.jobs.has(publication.trackId) || this.jobs.size >= 2) { this.buffer.markGap(); return; }
    const accept = this.buffer.bindTrack(publication.trackId, publication.ownerIdentity);
    if (!accept) return;
    const controller = new AbortController();
    this.jobs.set(publication.trackId, controller);
    let recognizer: Recognizer | undefined;
    try {
      recognizer = await this.open(result => {
        if (controller.signal.aborted || this.stopped) return;
        const segment = accept(result);
        if (segment) this.publish(segment);
      }, controller.signal);
      for await (const frame of publication.frames) {
        if (controller.signal.aborted || this.stopped) break;
        if (!(frame instanceof Uint8Array) || frame.length === 0 || frame.length > 64000 || frame.length % 2 !== 0) {
          this.buffer.markGap(); break;
        }
        await recognizer.write(frame);
      }
    } catch { this.buffer.markGap(); }
    finally {
      try { await recognizer?.close(); } catch { this.buffer.markGap(); }
      controller.abort(); this.jobs.delete(publication.trackId);
      this.buffer.unbindTrack(publication.trackId);
    }
  }
  /** Transport must honor cancellation and unblock its frame iterator. Week 4 adds bounded drain. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.jobs.values()) controller.abort();
    this.buffer.purge();
  }
}
