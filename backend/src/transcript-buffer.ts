import { uuidSchema } from './security-validation.js';

export type Segment = {
  sessionId: string; segmentId: string; revision: number;
  participantId: string; startMs: number; endMs: number; text: string;
  isFinal: boolean; attributionStatus: 'verified';
};
export type Recognition = Pick<Segment, 'segmentId' | 'revision' | 'startMs' | 'endMs' | 'text' | 'isFinal'>;
const keys = ['segmentId','revision','startMs','endMs','text','isFinal'];
const bytes = (s: string) => Buffer.byteLength(s);
function valid(input: unknown, duration: number): input is Recognition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const p = input as Record<string, unknown>;
  return Object.keys(p).length === keys.length && keys.every(k => Object.hasOwn(p,k)) &&
    typeof p.segmentId === 'string' && uuidSchema.safeParse(p.segmentId).success &&
    [p.revision,p.startMs,p.endMs].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) &&
    (p.startMs as number) <= (p.endMs as number) && (p.endMs as number) <= duration &&
    typeof p.text === 'string' && p.text.trim().length > 0 && p.text.length <= 4000 && typeof p.isFinal === 'boolean';
}

/** One instance per server-authorized active session. Never construct from client data. */
export class TranscriptBuffer {
  private readonly segments = new Map<string, Segment>();
  private readonly owners = new Map<string, symbol>();
  private readonly segmentBindings = new Map<string, symbol>();
  private readonly participants: Set<string>;
  private used = 0;
  private degraded = false;
  private closed = false;
  private frozen = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(readonly sessionId: string, members: readonly string[], readonly durationMs: number,
    private readonly maxBytes = 1048576, private readonly maxSegments = 4096) {
    if (!uuidSchema.safeParse(sessionId).success || members.length !== 2 || new Set(members).size !== 2 || !members.every(m => uuidSchema.safeParse(m).success) ||
      !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 1800000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 ||
      !Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > 4096) throw new Error('Invalid transcript configuration');
    this.participants = new Set(members);
    this.timer = setTimeout(() => this.purge(), durationMs + 300000);
    this.timer.unref();
  }
  get captureComplete() { return !this.degraded && !this.closed; }
  markGap() { this.degraded = true; }
  /** Call only with identity from authenticated LiveKit publication metadata. */
  bindTrack(trackId: string, owner: string): ((input: unknown) => Segment | null) | null {
    if (this.closed || this.frozen || !this.participants.has(owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) { this.markGap(); return null; }
    if (this.owners.has(trackId) || this.owners.size >= 32) { this.markGap(); return null; }
    const binding = Symbol(trackId);
    this.owners.set(trackId, binding);
    return (input: unknown) => {
      if (this.closed || this.frozen || this.owners.get(trackId) !== binding) return null;
      if (!valid(input, this.durationMs)) { this.markGap(); return null; }
      const old = this.segments.get(input.segmentId);
      if (old && this.segmentBindings.get(input.segmentId) !== binding) { this.markGap(); return null; }
      if (old && (old.isFinal || input.revision <= old.revision)) return null;
      if (old && input.startMs !== old.startMs) { this.markGap(); return null; }
      const next = this.used - (old ? bytes(old.text) : 0) + bytes(input.text);
      if (next > this.maxBytes || (!old && this.segments.size >= this.maxSegments)) { this.markGap(); return null; }
      const segment: Segment = { ...input, sessionId: this.sessionId, participantId: owner, attributionStatus: 'verified' };
      this.segments.set(segment.segmentId, segment);
      this.segmentBindings.set(segment.segmentId, binding);
      this.used = next;
      return { ...segment };
    };
  }
  unbindTrack(trackId: string, expectedEnd = false) {
    if (this.owners.delete(trackId) && !expectedEnd) this.markGap();
  }
  freeze(endMs = this.durationMs) {
    this.frozen = true;
    for (const [id, segment] of this.segments) {
      if (segment.endMs <= endMs) continue;
      this.markGap();
      this.used -= bytes(segment.text);
      this.segments.delete(id);
      this.segmentBindings.delete(id);
    }
  }
  /** Caller must already have authenticated the account and checked active session state. */
  snapshot(member: string): Segment[] | null {
    if (this.closed || !this.participants.has(member)) return null;
    return this.copy();
  }
  revision(id: string, revision: number): Segment | undefined {
    const segment = this.segments.get(id);
    if (segment?.revision === revision) return { ...segment };
  }
  /** Server-only handoff. Incomplete capture and insufficient speech cannot be scored. */
  evaluationInput(): Segment[] | null {
    if (!this.frozen || !this.captureComplete) return null;
    const final = this.copy().filter(segment => segment.isFinal);
    const counts = new Map<string, number>();
    const words = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const segment of final) {
      const count = [...words.segment(segment.text)].filter(word => word.isWordLike).length;
      counts.set(segment.participantId, (counts.get(segment.participantId) ?? 0) + count);
    }
    return [...this.participants].every(id => (counts.get(id) ?? 0) >= 50) ? final : null;
  }
  private copy() { return [...this.segments.values()].map(s => ({ ...s })).sort((a,b) => a.startMs-b.startMs || a.segmentId.localeCompare(b.segmentId)); }
  purge() { clearTimeout(this.timer); this.closed = true; this.segments.clear(); this.owners.clear(); this.segmentBindings.clear(); this.used = 0; }
}
