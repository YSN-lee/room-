import { z } from 'zod';
import { uuidSchema } from './security-validation.js';

export const sessionStateSchema = z.enum(['waiting', 'active', 'finishing', 'ended', 'cancelled']);
export const evaluationStatusSchema = z.enum(['pending', 'processing', 'completed', 'failed', 'unavailable']);
export const endReasonSchema = z.enum(['timer', 'user_end', 'disconnect', 'service_failure']);
const timestamp = z.union([z.date(), z.iso.datetime()]);
const transcriptStatus = z.enum(['capturing', 'degraded', 'unavailable']);
export const roomSnapshotSchema = z.strictObject({
  room: z.strictObject({ id: uuidSchema, status: z.enum(['waiting', 'active', 'closed', 'cancelled']), creatorId: uuidSchema, title: z.string(), description: z.string().nullable(), durationSeconds: z.number().int().min(120).max(1800) }),
  session: z.strictObject({ id: uuidSchema, state: sessionStateSchema, evaluationStatus: evaluationStatusSchema, startedAt: timestamp.nullable(), endsAt: timestamp.nullable(), endedAt: timestamp.nullable(), endReason: endReasonSchema.nullable(), serverTime: timestamp, transcriptStatus: transcriptStatus.optional() }),
  participants: z.array(z.strictObject({ participantId: uuidSchema, slot: z.union([z.literal(1), z.literal(2)]), ready: z.boolean(), consentVersion: z.string().nullable(), connection: z.enum(['connected', 'disconnected']) })).max(2),
});
const eventEnvelope = {
  event_id: uuidSchema, session_id: uuidSchema,
  sequence: z.number().int().positive(), server_time: z.iso.datetime(),
};
export const transcriptSegmentSchema = z.strictObject({
  sessionId: uuidSchema, segmentId: uuidSchema, revision: z.number().int().nonnegative(),
  participantId: uuidSchema, startMs: z.number().int().min(0).max(1800000),
  endMs: z.number().int().min(0).max(1800000), text: z.string().max(4000).refine(text => !!text.trim()),
  isFinal: z.boolean(), attributionStatus: z.literal('verified'),
}).refine(segment => segment.startMs <= segment.endMs, 'Invalid segment range');

export const sessionEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventEnvelope, type: z.literal('session.state'), payload: roomSnapshotSchema }),
  z.strictObject({ ...eventEnvelope, type: z.literal('transcript.segment'), payload: transcriptSegmentSchema }),
]).refine(event => event.session_id === (event.type === 'session.state' ? event.payload.session.id : event.payload.sessionId),
  'Event session must match payload');
export type SessionEvent = z.infer<typeof sessionEventSchema>;
