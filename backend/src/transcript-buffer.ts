export type Segment = {
  sessionId: string; segmentId: string; revision: number;
  participantId: string; startMs: number; endMs: number; text: string;
  isFinal: boolean; attributionStatus: 'verified';
};
export type Recognition = Pick<Segment, 'segmentId' | 'revision' | 'startMs' | 'endMs' | 'text' | 'isFinal'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = ['segmentId','revision','startMs','endMs','text','isFinal'];
const bytes = (s: string) => new TextEncoder().encode(s).length;
function valid(input: unknown, duration: number): input is Recognition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const p = input as Record<string, unknown>;
  return Object.keys(p).length === keys.length && keys.every(k => Object.hasOwn(p,k)) &&
    typeof p.segmentId === 'string' && uuid.test(p.segmentId) &&
    [p.revision,p.startMs,p.endMs].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) &&
    (p.startMs as number) <= (p.endMs as number) && (p.endMs as number) <= duration &&
    typeof p.text === 'string' && p.text.trim().length > 0 && p.text.length <= 4000 && typeof p.isFinal === 'boolean';
}

/** One instance per server-authorized active session. Never construct from client data. */
export class TranscriptBuffer {
  private readonly segments = new Map<string, Segment>();
  private readonly owners = new Map<string, string>();
  private readonly participants: Set<string>;
  private used = 0;
  private degraded = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(readonly sessionId: string, members: readonly string[], readonly durationMs: number,
    private readonly maxBytes = 1048576, private readonly maxSegments = 4096) {
    if (!uuid.test(sessionId) || members.length !== 2 || new Set(members).size !== 2 || !members.every(m => uuid.test(m)) ||
      !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 1800000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 ||
      !Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > 4096) throw new Error('Invalid transcript configuration');
    this.participants = new Set(members);
    this.timer = setTimeout(() => this.purge(), durationMs + 300000);
  }
  get captureComplete() { return !this.degraded && !this.closed; }
  markGap() { this.degraded = true; }
  /** Call only with identity from authenticated LiveKit publication metadata. */
  bindTrack(trackId: string, owner: string): ((input: unknown) => Segment | null) | null {
    if (this.closed || !this.participants.has(owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) { this.markGap(); return null; }
    if (this.owners.has(trackId) || this.owners.size >= 32) { this.markGap(); return null; }
    this.owners.set(trackId, owner);
    return (input: unknown) => {
      if (this.closed || this.owners.get(trackId) !== owner) return null;
      if (!valid(input, this.durationMs)) { this.markGap(); return null; }
      const old = this.segments.get(input.segmentId);
      if (old && old.participantId !== owner) { this.markGap(); return null; }
      if (old && (old.isFinal || input.revision <= old.revision)) return null;
      if (old && input.startMs !== old.startMs) { this.markGap(); return null; }
      const next = this.used - (old ? bytes(old.text) : 0) + bytes(input.text);
      if (next > this.maxBytes || (!old && this.segments.size >= this.maxSegments)) { this.markGap(); return null; }
      const segment: Segment = { ...input, sessionId: this.sessionId, participantId: owner, attributionStatus: 'verified' };
      this.segments.set(segment.segmentId, segment); this.used = next;
      return { ...segment };
    };
  }
  unbindTrack(trackId: string) { if (this.owners.delete(trackId)) this.markGap(); }
  /** Caller must already have authenticated the account and checked active session state. */
  snapshot(member: string): Segment[] | null {
    if (this.closed || !this.participants.has(member)) return null;
    return this.copy();
  }
  /** Internal only. Provisional segments are never evaluation input. Week 4 adds freeze/drain. */
  finalized(): Segment[] { return this.closed ? [] : this.copy().filter(s => s.isFinal); }
  private copy() { return [...this.segments.values()].map(s => ({ ...s })).sort((a,b) => a.startMs-b.startMs || a.segmentId.localeCompare(b.segmentId)); }
  purge() { clearTimeout(this.timer); this.closed = true; this.segments.clear(); this.owners.clear(); this.used = 0; }
}
