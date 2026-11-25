import { sessionEventSchema } from './room-contracts.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { PrismaClient } from '@prisma/client';
import type { Express, RequestHandler } from 'express';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { PrismaRoomLifecycleService, type RoomSnapshot } from './room-lifecycle.js';
import { AppError } from './security-errors.js';
import { emptyBodySchema, validateBody, uuidSchema, parseInput, parseEvent } from './security-validation.js';
import { LiveKitTranscription } from './livekit-transcription.js';
import { whisperLiveKit } from './whisper-livekit.js';
import type { Segment } from './transcript-buffer.js';
import type { SecurityConfig } from './security-config.js';

export function sessionRuntime(db: PrismaClient, service: PrismaRoomLifecycleService, config: SecurityConfig) {
  const internalUrl = process.env.LIVEKIT_INTERNAL_URL ?? 'http://livekit:7880';
  const rtcUrl = internalUrl.replace(/^http/, 'ws');
  const media = new RoomServiceClient(internalUrl, config.livekitApiKey, config.livekitApiSecret);
  const roomName = (id: string) => `room_${id}`;
  const clients = new Map<WebSocket, { user: string; session: string; authorization: string; alive: boolean }>();
  const openRecognizer = process.env.WHISPERLIVEKIT_URL ? whisperLiveKit(process.env.WHISPERLIVEKIT_URL) : undefined;
  const captures = new Map<string, LiveKitTranscription>();
  const eventQueues = new Map<string, { tail: Promise<void>; pending: number }>();
  let verifyAuthorization: ((header?: string) => Promise<string>) | undefined;
  let closeEvents: (() => void) | undefined;
  let stopped = false;

  async function member(sessionId: string, user: string) {
    const session = await db.debateSession.findUnique({ where: { id: sessionId }, include: { participants: true } });
    const participant = session?.participants.find(p => p.userId === user);
    if (!session || !participant) throw new AppError(404, 'NOT_FOUND');
    return { session, participant };
  }
  async function humanToken(id: string, user: string) {
    return db.$transaction(async tx => {
      const initial = await member(id, user);
      await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${initial.session.roomId}::uuid FOR UPDATE`;
      const session = await tx.debateSession.findUniqueOrThrow({ where: { id }, include: { participants: true } });
      const participant = session.participants.find(p => p.userId === user);
      if (!participant) throw new AppError(404, 'NOT_FOUND');
      if (session.state !== 'WAITING' && !publishable(session)) throw new AppError(409, 'STATE_CONFLICT');
      if (!participant.consentAt || participant.consentVersion !== (process.env.CONSENT_VERSION ?? 'privacy-v1')) throw new AppError(403, 'FORBIDDEN');
      const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, { identity: user, ttl: '5m' });
      token.addGrant({ roomJoin: true, room: roomName(id), canPublish: session.state === 'ACTIVE', canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false, roomAdmin: false, roomRecord: false });
      await tx.debateSession.update({ where: { id }, data: { mediaGrantExpiresAt: new Date(Date.now() + 300000), mediaClosed: false } });
      return { sessionId: id, participantId: user, roomName: roomName(id), grantMode: session.state === 'ACTIVE' ? 'active' : 'preflight', token: await token.toJwt(), serverUrl: config.livekitPublicUrl };
    });
  }
  const preflightSchema = z.strictObject({ microphoneReady: z.boolean() });
  function routes(app: Express, authenticate: RequestHandler) {
    app.get('/api/sessions/:sessionId/transcript', authenticate, async (req, res) => {
      const id = parseInput(uuidSchema, req.params.sessionId);
      const user = res.locals.authenticatedUserId as string;
      const { session } = await member(id, user);
      if (!publishable(session)) throw new AppError(409, 'STATE_CONFLICT');
      const capture = captures.get(id);
      if (capture && !capture.active) throw new AppError(409, 'STATE_CONFLICT');
      const segments = capture?.buffer.snapshot(user);
      res.set('Cache-Control', 'no-store').json({
        sessionId: id, sequence: session.eventSequence, segments: segments ?? [],
        status: transcriptStatus(id),
      });
    });
    app.post('/api/sessions/:sessionId/audio-preflight', authenticate, validateBody(preflightSchema), async (req, res) => {
      const id = parseInput(uuidSchema, req.params.sessionId);
      const user = res.locals.authenticatedUserId as string;
      const { session } = await member(id, user);
      if (!['WAITING', 'ACTIVE'].includes(session.state)) throw new AppError(409, 'STATE_CONFLICT');
      const connected = await media.listParticipants(roomName(id));
      if (!connected.some(p => p.identity === user)) throw new AppError(409, 'AUDIO_NOT_CONNECTED');
      await db.sessionParticipant.updateMany({ where: { sessionId: id, userId: user, session: { state: { in: ['WAITING', 'ACTIVE'] } } }, data: { microphoneReady: req.body.microphoneReady, audioConnected: true, audioObservedAt: new Date() } });
      res.status(204).end();
    });
    app.post('/api/sessions/:sessionId/media-token' , authenticate, validateBody(emptyBodySchema), async (req, res) => {
      const id = parseInput(uuidSchema, req.params.sessionId);
      res.json(await humanToken(id, res.locals.authenticatedUserId));
    });
  }
  // Server-only API: never mount this function on a browser-accessible route.
  async function asrToken(id: string) {
    return db.$transaction(async tx => {
      const initial = await tx.debateSession.findUnique({ where: { id } });
      if (!initial) throw new AppError(404, 'NOT_FOUND');
      await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${initial.roomId}::uuid FOR UPDATE`;
      const session = await tx.debateSession.findUniqueOrThrow({ where: { id } });
      if (!publishable(session)) throw new AppError(409, 'STATE_CONFLICT');
      const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, { identity: `asr_${id}`, ttl: '5m' });
      token.addGrant({ roomJoin: true, room: roomName(id), canPublish: false, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false, roomAdmin: false, roomRecord: false, hidden: true });
      await tx.debateSession.update({ where: { id }, data: { mediaGrantExpiresAt: new Date(Date.now() + 300000), mediaClosed: false } });
      return token.toJwt();
    });
  }
  function transcriptStatus(id: string) {
    const capture = captures.get(id);
    if (!capture?.active) return 'unavailable';
    return capture.degraded ? 'degraded' : 'capturing';
  }

  function publishable(session: { state: string; endsAt: Date | null }) {
    return session.state === 'ACTIVE' && !!session.endsAt && session.endsAt.getTime() > Date.now();
  }
  function enqueue(id: string, send: () => Promise<void>, limit = Infinity): Promise<void> | undefined {
    const queue = eventQueues.get(id) ?? { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= limit) return;
    queue.pending++;
    eventQueues.set(id, queue);
    const task = queue.tail.then(send);
    queue.tail = task.catch(() => {}).finally(() => {
      if (--queue.pending === 0) eventQueues.delete(id);
    });
    return task;
  }

  async function broadcast(id: string, type: 'session.state' | 'transcript.segment', payload: unknown) {
    if (![...clients.values()].some(subscription => subscription.session === id)) return;
    const row = await db.debateSession.update({ where: { id }, data: { eventSequence: { increment: 1 } }, select: { eventSequence: true } });
    const event = JSON.stringify(sessionEventSchema.parse({
      event_id: randomUUID(), session_id: id, type, sequence: row.eventSequence,
      server_time: new Date().toISOString(), payload,
    }));
    await Promise.all([...clients].map(async ([socket, subscription]) => {
      if (subscription.session !== id || socket.readyState !== WebSocket.OPEN) return;
      try {
        const user = await verifyAuthorization?.(subscription.authorization);
        if (user !== subscription.user) throw new Error('Invalid event identity');
        const { session } = await member(id, user);
        if (type === 'transcript.segment' && (!publishable(session) || !captures.get(id)?.active)) return;
        if (socket.readyState !== WebSocket.OPEN || clients.get(socket) !== subscription) return;
        if (socket.bufferedAmount > 65536) socket.close(1013);
        else socket.send(event, error => { if (error) socket.terminate(); });
      } catch {
        socket.close(1008);
      }
    }));
  }

  function broadcastState(id: string, roomId: string, user: string) {
    const task = enqueue(id, async () => {
      if (![...clients.values()].some(subscription => subscription.session === id)) return;
      const snapshot = await service.readRoom(roomId, user, new Date());
      await broadcast(id, 'session.state', {
        ...snapshot,
        session: { ...snapshot.session, transcriptStatus: transcriptStatus(id) },
      });
    }, 64);
    return task ?? Promise.reject(new Error('Session delivery queue full'));
  }

  function startCapture(id: string, members: string[], startedAt: Date | null, endsAt: Date | null, recovered = false) {
    if (stopped || !openRecognizer || captures.has(id) || !startedAt || !endsAt || endsAt.getTime() <= Date.now() ||
        members.length !== 2) return;
    const capture = new LiveKitTranscription(id, members, startedAt.getTime(), endsAt.getTime(), openRecognizer,
      ({ segmentId, revision }: Segment) => {
        const task = enqueue(id, async () => {
          const segment = captures.get(id)?.buffer.revision(segmentId, revision);
          if (segment) await broadcast(id, 'transcript.segment', segment);
        }, 64);
        const reconnect = () => {
          for (const [socket, subscription] of clients) {
            if (subscription.session === id) socket.close(1013);
          }
        };
        if (task) void task.catch(reconnect);
        else reconnect();
      }, () => {
        if (captures.get(id) === capture) captures.delete(id);
      });
    if (recovered) capture.buffer.markGap();
    captures.set(id, capture);
    void capture.connect(rtcUrl, () => asrToken(id));
  }

  async function finishCapture(id: string, endedAt: Date | null): Promise<boolean> {
    const capture = captures.get(id);
    if (!capture) return false;
    if (endedAt) await capture.finish(endedAt.getTime());
    const complete = !!endedAt && capture.buffer.captureComplete;
    capture.dispose();
    captures.delete(id);
    return complete;
  }

  function onSessionState(snapshot: RoomSnapshot) {
    const { session, participants } = snapshot;
    if (session.state === 'active') {
      startCapture(session.id, participants.map(p => p.participantId), session.startedAt, session.endsAt);
    } else if (session.state === 'finishing' && session.endedAt) {
      void captures.get(session.id)?.finish(session.endedAt.getTime());
    }
  }

  function shutdown() {
    stopped = true;
    closeEvents?.();
    for (const capture of captures.values()) capture.dispose();
    captures.clear();
  }
  let busy = false;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const now = new Date();
      const sessions = await db.debateSession.findMany({ where: { OR: [{ state: { in: ['WAITING', 'ACTIVE', 'FINISHING'] } }, { state: { in: ['ENDED', 'CANCELLED'] }, mediaClosed: false }] }, include: { room: true, participants: true } });
      for (const session of sessions) {
        try {
          if (session.state === 'WAITING' && session.room.inviteExpiresAt <= now) await service.cancelRoom(session.roomId, session.room.creatorId, now);
          if (session.state === 'ACTIVE' && session.endsAt && session.endsAt <= now) await service.endSession(session.id, 'TIMER', now);
          let current = await db.debateSession.findUniqueOrThrow({ where: { id: session.id } });
          if (publishable(current)) {
            startCapture(session.id, session.participants.map(p => p.userId), current.startedAt, current.endsAt, true);
          }
          if (current.state === 'WAITING' || current.state === 'ACTIVE') {
            const connected = await media.listParticipants(roomName(session.id)).catch(error => {
              if (error?.code === 'not_found' || error?.status === 404) return [];
              throw error;
            });
            const membership = await db.sessionParticipant.findMany({ where: { sessionId: session.id }, select: { userId: true } });
            for (const peer of connected) {
              if (!membership.some(p => p.userId === peer.identity) && !(current.state === 'ACTIVE' && peer.identity === `asr_${session.id}`)) {
                await media.removeParticipant(roomName(session.id), peer.identity);
              }
            }
            for (const participant of session.participants) {
              const present = connected.some(p => p.identity === participant.userId);
              if (current.state === 'ACTIVE' && participant.disconnectDeadline && participant.disconnectDeadline <= now) {
                await service.endSession(session.id, 'DISCONNECT', now);
                break;
              }
              await service.markAudioConnection(session.id, participant.userId, present);
              if (!present && current.state === 'ACTIVE') {
                await db.sessionParticipant.updateMany({ where: { id: participant.id, disconnectDeadline: null, audioConnected: false }, data: { disconnectDeadline: new Date(now.getTime() + 60000) } });
                const observed = await db.sessionParticipant.findUniqueOrThrow({ where: { id: participant.id } });
                if (observed.disconnectDeadline && observed.disconnectDeadline <= now) await service.endSession(session.id, 'DISCONNECT', now);
              }
            }
          }
          current = await db.debateSession.findUniqueOrThrow({ where: { id: session.id } });
          if (['FINISHING', 'ENDED', 'CANCELLED'].includes(current.state)) {
            const captureComplete = await finishCapture(session.id, current.state === 'FINISHING' ? current.endedAt : null);
            // Persist only completion metadata. There is no scoring adapter in this release.
            await db.debateSession.updateMany({
              where: { id: session.id, evaluationStatus: 'PENDING' },
              data: { evaluationStatus: 'UNAVAILABLE', captureComplete },
            });
            await media.deleteRoom(roomName(session.id)).catch(error => {
              if (error?.code !== 'not_found' && error?.status !== 404) throw error;
            });
            await service.completeFinalization(session.id);
            // Keep closing a room recreated by an already-issued token until its grant expires.
            if (!current.mediaGrantExpiresAt || current.mediaGrantExpiresAt <= now) await db.debateSession.update({ where: { id: session.id }, data: { mediaClosed: true } });
          }
          // Delivery failures must not terminate an otherwise healthy session.
          void broadcastState(session.id, session.roomId, session.room.creatorId)?.catch(() => {
            for (const [socket, client] of clients) if (client.session === session.id) socket.close(1013);
          });
        } catch {
          // A failed media dependency cannot leave an active discussion running indefinitely.
          await finishCapture(session.id, null);
          await service.endSession(session.id, 'SERVICE_FAILURE', now);
          if (session.state === 'FINISHING') await service.completeFinalization(session.id);
        }
      }
    } finally { busy = false; }
  }
  function attach(server: Server, verify: (header?: string) => Promise<string>) {
    verifyAuthorization = verify;
    const wss = new WebSocketServer({ server, path: '/api/events', maxPayload: 16384, verifyClient: (info: { origin: string }) => config.allowedOrigins.includes(info.origin) });
    wss.on('connection', socket => {
      if (wss.clients.size > 100) { socket.close(1013); return; }
      socket.on('error', () => socket.terminate());
      socket.on('pong', () => { const c = clients.get(socket); if (c) c.alive = true; });
      const timeout = setTimeout(() => socket.close(1008), 5000);
      let received = false;
      socket.on('message', async data => {
        if (received) { socket.close(1008); return; }
        received = true;
        try {
          const input = parseEvent(z.strictObject({ authorization: z.string().min(8).max(8192), session_id: uuidSchema }), data.toString());
          const user = await verify(input.authorization);
          const session = uuidSchema.parse(input.session_id);
          const { session: state } = await member(session, user);
          if (socket.readyState !== WebSocket.OPEN) return;
          if ([...clients.values()].filter(c => c.user === user).length >= 4) throw new AppError(429, 'RATE_LIMITED');
          clients.set(socket, { user, session, authorization: input.authorization, alive: true });
          clearTimeout(timeout);
          await broadcastState(session, state.roomId, user);
        } catch { socket.close(1008); }
      });
      socket.on('close', () => { clearTimeout(timeout); clients.delete(socket); });
    });
    const heartbeat = setInterval(() => {
      for (const [socket, client] of clients) {
        if (!client.alive) { socket.terminate(); continue; }
        client.alive = false;
        void verify(client.authorization).then(() => member(client.session, client.user)).then(() => socket.ping()).catch(() => socket.close(1008));
      }
    }, 15000);
    heartbeat.unref();
    const timer = setInterval(() => void tick().catch(() => console.error('Session reconciliation failed')), 1000);
    timer.unref();
    closeEvents = () => {
      closeEvents = undefined;
      clearInterval(timer);
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    };
    server.on('close', shutdown);
    void tick().catch(() => console.error('Session recovery failed'));
  }
  return { routes, attach, asrToken, tick, onSessionState, shutdown };
}
