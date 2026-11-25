# Member 4 — Week 1 design contract (recovered)

Original: ROOM_Member4_Week1_Design.pdf, draft v0.1 dated 11 November 2026. This is a Markdown recovery of the design, not the original binary PDF or proof of teammate approval. Source: ROOM SRS v1.0 FR-14–27, INT-02–03, DATA-01–02 and Team Roles v1.0.

## Transcript
Server-owned sessionId and segmentId UUIDs; nonnegative integer revision, participantId UUID or null, startMs/endMs relative to session start, text (max 4,000 characters), isFinal boolean, attributionStatus verified/unknown (unknown requires null participantId). Identity comes from authenticated LiveKit track owner, never a browser or ASR speaker label. Drop duplicate/stale revisions; final text cannot be replaced by a later partial. Reject invalid IDs, unknown fields and invalid ranges. Bound canonical text to 1 MiB/session; missing capture or unknown attribution makes evaluation unavailable. Reconnect is a membership-gated server-memory snapshot; never accept client cache as scoring input.

Synthetic example: sessionId 8db34b6d-41ef-4f5c-818a-8b8d5c22bc4e, segmentId da33d1c8-a05b-4858-8e66-a84216a4b038, participantId c8453f77-9d21-44cf-85a1-af0c3b5e6d80, revision 1, startMs 1230, endMs 4070, text "Public libraries should remain open.", isFinal true, attributionStatus verified.

Member 2 owns event sequencing and routing. Week 1 proposed camelCase envelope; current session-runtime uses snake_case envelope (event_id, session_id, server_time), while frontend segment DTO uses camelCase. Agree envelope and transcript payload with Members 2/3 before enabling live delivery.

## Evaluation
Separate pending/processing/completed/failed/unavailable states. Completed result: sessionId, modelId, rubricVersion, evaluatedAt UTC, exactly two distinct known participantResults, claimChecks (max five), assessmentNotice. Participant result: participantId, four finite 0–25 scores, server-computed total, bounded feedback. Four draft criteria: argumentQuality, reasoning, relevance, persuasiveness; equal weights, total 0–100, ties remain ties. Draft anchor bands: 0 absent, 1–9 weak, 10–17 developing, 18–22 strong, 23–25 excellent. No score without complete attributed capture and at least 50 recognized words per participant; do not penalize accent, identity or mic quality. Claim verdicts separate from scores. Claim DTO: participantId, claimParaphrase, verdict supported/contradicted/mixed/insufficient_evidence, explanation, sources (title, approved retrieved HTTPS URL, accessedAt UTC). No invented citations. Failed/unavailable: safe failureCode, empty results/claims. No fabricated winner. One transactional result per session.

Synthetic example: scores 20/18/22/17 = 77; 19/21/20/20 = 80. These are fixtures, not real judgments.

## Retention and lifecycle
Waiting: consent, no official capture. Active: restricted subscriber identity, bounded memory only; browser display cache owned by M3. Finishing: stop audio, drain up to five seconds, freeze input, trigger evaluation once. Approved provider request timeout 60 seconds with one bounded transient retry. Purge temporary data on success/permanent failure, hard maximum five minutes from finish. Restart loses memory; mark unavailable, never restore official transcript from browser. No raw audio, transcript, prompt or scraped pages in DB, logs, disk queues, volumes or analytics. External provider retention and browser offline cleanup limitations must be disclosed.

## Handoffs and outstanding decisions
M1 transactional result schema/writer; M2 authenticated tracks, room lifecycle, event sequence and snapshot authorization; M3 segment/result UI and cache cleanup; M5 provider/egress, privacy and security review. Confirm rubric, word threshold, unknown-speaker handling, exact field lengths, approved providers, language, model, host, cost and retention before real speech processing. Local WhisperLiveKit microphone-to-text was observed according to the original draft; this does not prove LiveKit integration.

## Acceptance fixtures
AT-05 synthetic two-speaker attribution, revisions, browser tamper isolation. AT-06 end/cancel/logout/expiry and no transcript markers in persistence/logs. AT-07 valid totals, reject malformed scores, unknown IDs, invented citations and injection. AT-08 ASR/LLM/evidence outages, restart, safe unavailable state. These are planned checks, not recorded results.
