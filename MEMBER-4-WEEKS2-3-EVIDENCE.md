# Member 4 Weeks 2–3 implementation evidence

The backend now connects authenticated LiveKit microphone tracks to WhisperLiveKit 0.2.26. Two-speaker routing, live delivery, reconnect, and provider-failure checks passed against real LiveKit and PostgreSQL. The follow-up below records a successful model-backed two-speaker run. Production recognition accuracy and latency remain open.

## Capture and retention

- The room controller starts a hidden, subscribe-only RTC participant after the session becomes active. LiveKit account identity and microphone publication metadata bind each track to its canonical speaker. Each track gets an independent mono PCM16, 16 kHz WhisperLiveKit stream.
- The canonical buffer validates IDs, ranges, track bindings, and revision order. It caps recognized text at 1 MiB UTF-8 and 4,096 segments per session. The application streams provider-final results live. The buffer supports revision-aware consumers and accepts only frozen, complete, attributed final input for the server-side evaluation handoff, with at least 50 recognized words per speaker.
- Capture stops at finish or expiry. The provider receives a close request and has up to five seconds to drain. Missing track coverage, provider failure, and process restart make capture incomplete. The controller purges the buffer at terminal reconciliation and enforces a five-minute maximum from finish. With no scoring adapter connected, the session records evaluation unavailable.
- PostgreSQL receives event sequence, capture completion, and lifecycle metadata. The application streams audio and holds transcript text in memory. The Compose ASR service has an internal network, read-only model mount, and disabled container logging. The nginx proxy avoids buffering transcript responses to disk.

## Client contract

Connect to `/api/events` with an allowed Origin. Send one frame containing `authorization` and `session_id`, as for existing room events. The server verifies the token and session membership before delivery. Each `transcript.segment` event uses the existing snake_case envelope and a camelCase segment payload. `session.state.payload.session.transcriptStatus` reports live availability without new polling. Apply events by segment ID and revision.

On reconnect, buffer live events while waiting for the first `session.state` event. For an active session, fetch `GET /api/sessions/:sessionId/transcript` with the bearer token. The no-store response contains `sessionId`, `sequence`, `segments`, and a status of `capturing`, `degraded`, or `unavailable`. Replace the local view from this snapshot and apply newer events by sequence and revision. Discard the view on sign-out or terminal session state. The authenticated lobby mounts Member 3’s transcript panel for active sessions. Its client clears on termination, disconnect, page navigation, and authenticated view unmount. The standalone debate demo remains a preview.

Enable the private Compose transcription profile with `WHISPERLIVEKIT_URL=ws://transcription:8000` and a complete, reviewed CTranslate2 model mounted at `/models/model` and readable by the ASR service user. Authenticated deployments also need the existing JWKS issuer, audience, and URL.

## Initial review checks

- Backend on Node 24.22.3: clean lockfile install, Prisma generation, type checks, build, and 103 Vitest tests in eight suites.
- Frontend: clean install, type checks, build, and 25 Vitest tests in six suites. The locked tarball mirror was inaccessible to the Linux build. The lockfile now uses the npm registry for those tarballs, preserving their versions and integrity hashes.
- Real LiveKit and PostgreSQL with signed JWTs and a local JWKS endpoint: two simultaneous synthetic publishers produced independently identifiable PCM streams. A deterministic WebSocket ASR fixture emitted distinct final transcripts. A separate microphone replacement run verified new segments stayed assigned to the original authenticated owner and the capture became incomplete. The authenticated feed and reconnect snapshot attributed both correctly. Nonmembers failed authorization. Transcript mutation via HTTP, finish payload, and WebSocket was rejected. Finish closed the media room, blocked snapshot access, and left the transcript markers out of the test schema dump and API audit records.
- Real WhisperLiveKit 0.2.26: the private ASR image built successfully and drained PCM as a non-root, read-only container with networking disabled and inference off. Two real RTC streams carrying different synthesized voices passed the PCM and drain protocol check with inference disabled. A separate provider-outage run returned a degraded snapshot, recorded incomplete capture, and ended with evaluation unavailable. An active-session restart produced a degraded capture and discarded old segment IDs. Advancing a fixture session deadline in PostgreSQL exercised the timer reconciliation and terminal cleanup.
- An isolated Compose stack built the backend and frontend, applied the migrations, and passed API, frontend, LiveKit service, nginx WebSocket, and synthetic log-privacy smoke tests. The backup/restore check restored the durable fixture exactly once and verified the runtime role stayed unprivileged. The sandbox copy of the Postgres init script needed readable permissions for the container user. The test stack used a temporary mount override.
- Source secret scans and layout checks passed against the branch's current main base. The default CI layout reference predates teammates' frontend reorganization. With that reference corrected for the run, CI reached the backend audit gate and stopped on the Prisma/Effect advisory also present in the original lockfile. The standalone frontend audit reported zero vulnerabilities.
- Model retrieval from Hugging Face returned HTTP 403 through the managed network. The inference-enabled start failed without local weights. Model-backed recognition, deployment load, and full two-browser media and sign-out acceptance remain unverified. The transcript client tests exercise reconnect, revision merging, terminal handling, page navigation, and unmount. The fixture verifies account-to-track routing. It cannot verify the physical speaker behind a microphone.

Run `npm ci`, `npm run db:generate`, `npm run typecheck`, `npm test`, and `npm run build` in `backend` for the checked-in verification. The provider protocol tests use loopback WebSockets and require no model.

## Model-backed follow-up

### Provisioning

The acceptance model is SYSTRAN’s MIT-licensed `faster-whisper-tiny.en`, a CTranslate2 conversion of OpenAI Whisper Tiny English. The upstream revision is `0d3d19a32d3338f10357c0889762bd8d64bbdeba`. Keep the model outside Git.

On a machine with access to Hugging Face, download the four files from the pinned revision using normal TLS verification:

```sh
hf download Systran/faster-whisper-tiny.en config.json model.bin tokenizer.json vocabulary.txt \
  --revision 0d3d19a32d3338f10357c0889762bd8d64bbdeba --local-dir /path/to/download
mkdir -p .local/models/model
install -m 0444 /path/to/download/{config.json,model.bin,tokenizer.json,vocabulary.txt} .local/models/model/
bash backend/scripts/verify-whisper-model.sh .local/models/model
```

The verifier uses GNU `sha256sum` and expects a directory containing exactly those four regular files. It checks all four digests. Use the read-only model mount, private ASR network, offline mode, and log settings already provided by the Compose transcription profile. Keep `WHISPERLIVEKIT_URL=ws://transcription:8000` configured for that profile. The upstream model repository publishes the weight digest. The support-file digests pin the bytes used during this acceptance run. [Pinned model and upstream weight digest](https://huggingface.co/Systran/faster-whisper-tiny.en/blob/0d3d19a32d3338f10357c0889762bd8d64bbdeba/model.bin)

The managed instance declined the scoped Hugging Face network change. For this synthetic run, the four regular files came from the `faster-tiny.en.7z` release asset below. The archive SHA-256 was `4723bd8ce0a714154210ec234567f305b62a0f6af174ccee26cdbd47b0ac843c`. The extracted `model.bin` matched the independently published SYSTRAN digest. The verifier accepted the four-file bundle and rejected a modified tokenizer and an extra preprocessor configuration. Use the upstream revision for deployment and have Member 5 review any alternate distribution source. [Release asset](https://github.com/jianchang512/stt/releases/download/0.0/faster-tiny.en.7z)

OpenAI’s separate `tiny.en.pt` checkpoint also matched the publisher’s SHA-256 and loaded offline with PyTorch weights-only loading. WhisperLiveKit 0.2.26’s shared PyTorch backend hit a word-alignment tensor shape error under two concurrent streams. Keep the configured Faster Whisper backend for concurrent capture. [OpenAI checkpoint digests](https://github.com/openai/whisper/blob/main/whisper/__init__.py)

### Interim and dependency checks

A direct model-backed provider probe returned interim text with zero-duration ranges, followed by a final with a start time over two seconds earlier. It also produced adjacent final ranges ending at 640 ms and starting at 620 ms. The ROOM transport now clamps a small overlap at the previous final boundary and keeps both texts. A regression test reproduces those exact ranges.

Keep the deployed feed final-only until Members 2 and 3 agree on how to replace provisional timestamps, withdraw empty hypotheses, and reconcile a finalized prefix with a remaining provisional tail. The existing canonical revision rules and panel reconciliation still pass. End-to-end interim delivery remains open.

The advisory fix pins Effect 3.22.5 only beneath `@prisma/config`, with Prisma still at 6.19.3. Clean installation, Prisma generation, type checks, builds, the backend suite, and both npm audits passed. Member 5 can review the narrow override as part of release sign-off.

### Acceptance results and owner handoff

- Two synthesized voices entered real LiveKit as separate microphone tracks. WhisperLiveKit 0.2.26 used the verified CTranslate2 weights and Faster Whisper backend on CPU. The actual transcript included “The library has lots of books” for the first authenticated owner and “City parks are open to everyone” for the second. The harness found each expected marker only on its own track. Word substitutions appeared in other repetitions, so this establishes recognition and attribution for the fixture. It leaves accuracy and latency targets open.
- The real model-backed API run passed participant snapshots, nonmember rejection, HTTP and WebSocket tamper rejection, and terminal media cleanup. It blocked transcript reads after finish and found no phrase markers in the synthetic test database dump or API audit records.
- Two Chrome tabs using separate synthetic principals displayed the same model-backed transcript with the appropriate speaker labels. The first tab cleared on its fixture sign-out action. The second tab cleared on a real finish request. The fixture mounted auth in memory and used native RTC publishers. Member 1 still needs to supply production sign-in and shared sign-out behavior. Members 2 and 3 need to run the complete browser microphone, reconnect, and cross-tab cleanup flow with those production entry points.
- The backend suite passed 104 tests across eight files. The frontend suite passed 25 tests across six files. Both type checks and builds passed. The repository CI check passed with the current layout base `cb8bec8`; both npm audits reported zero vulnerabilities.
