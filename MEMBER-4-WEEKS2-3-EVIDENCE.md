# Member 4 — Weeks 2–3 implementation evidence

Status: partial implementation; not acceptance sign-off. Source: Week 1 draft, SRS FR-14–20 and AT-05/06, current session-runtime.ts and room-contracts.ts.

## Implemented
- backend/src/transcription-adapter.ts: transport-independent per-track PCM16 adapter; separate recognizer per track, membership binding, microphone filtering, cancellation signal, provider failure flag.
- backend/src/transcript-buffer.ts: server-owned attribution, strict recognition shape, revision rules, 1 MiB UTF-8 text cap, 4096 segment cap, 32 track metadata cap, isolated member snapshots, purge.
- backend/scripts/*.test.ts: two Member 4 suites.

## Executed evidence
Node 22.16.0, TypeScript 5.8.3, strict compilation ES2022/NodeNext. Nine cases passed using actual committed test source and an isolated Node assert compatibility runner implementing only the used Vitest functions; official Vitest, full backend typecheck and full repository CI were NOT run. GitHub readback matched tested file blob hashes:
- buffer 89c0aaf98cc7ea99b8a0de96e7e2c15d5933b2f1
- buffer tests c7f71e5cd020de6b70eb4d3c17d3036ae5a49842
- adapter 8f91fb44cdfd4d3312312330cacbfd3918aa7287
- adapter tests c1d10028131a05b49aa9524f446dfae5133cf046

## Outstanding integration and risks
No actual LiveKit RTC subscriber or WhisperLiveKit network recognizer is implemented yet. The injected publication metadata is trustworthy only once the server RTC transport is wired to authenticated LiveKit tracks; do not expose consume() to clients. Current session-runtime.asrToken is server-only; use it. Current room-contracts sessionEventSchema only accepts session.state; coordinate transcript.segment payload and member-only snapshot route with M2/M3. ASR service is isolated on an internal network; coordinate private bridge networking and dependencies with M5. Current adapter assumes cancellation-aware iterator and recognizer; bounded close/drain, hard finish-based expiry, provider timestamps, coverage, unknown attribution display, event publication and end-to-end browser tamper tests remain pending. Track completion conservatively marks capture incomplete; no official evaluation is possible yet. No raw speech or transcript is written by these modules; full-system privacy evidence is pending. Docker unavailable; GitHub clone DNS failed in local environment; dependency install/full tests not possible.

## Reproduce in repository
From backend with reviewed lockfile dependencies installed: npx vitest run scripts/transcript-buffer.test.ts scripts/transcription-adapter.test.ts
Run full npm test and npm run typecheck before integration. Then run real two-participant synthetic speech through actual RTC and ASR, check attribution/revisions, reconnect snapshot authorization, no DB/log persistence, and failure handling. Do not mark Weeks 2/3 done until the required demonstrations pass.
