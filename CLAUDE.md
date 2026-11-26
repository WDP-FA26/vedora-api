# vedora-api

Backend for Vedora, a social platform for vegetarian and plant-based cooking. NestJS 11, Mongoose 9 / MongoDB 8, Qdrant, RustFS (S3), Cloudinary, OpenRouter, Redis, ffmpeg; npm. The frontend is the separate repo `WDP-FA26/vedora-frontend` (usually checked out next to this one as `../vedora-frontend`); a change spanning both needs a commit/PR in each.

## Local setup

The API runs on **4000** (the frontend uses 3000). `README.md` and `docker-compose.yml` still show 3000 for the API; that is stale. Needs Node >= 26.12.1; only MongoDB/Qdrant/RustFS/Redis run in Docker.

```bash
cp .env.example .env                      # first time only; never commit .env
docker compose up -d mongo qdrant rustfs redis
docker compose up -d mongo-test          # RAM-backed MongoDB on 27018 that the test suites use
npm install
npm run seed                              # catalog + admin user `vedora.admin` (password = SEED_USER_PASSWORD)
npm run start:dev                         # http://localhost:4000/api/v1, Swagger at /docs
```

Requires `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY` and a reachable Qdrant. Without `RESEND_API_KEY`, email verification/reset codes print in the API log; without Cloudinary, Google, or Turnstile credentials those features return `503` or use test behavior.

## Commands

```bash
npm run build
npm run lint                    # type-aware eslint; also covers test/
npm run format                  # prettier: single quotes, trailing commas
npm test                        # unit (Vitest), test/unit/**/*.spec.ts
npm run test:e2e                # HTTP e2e via supertest, disposable MongoDB database per spec
npm run test:db                 # opt-in; needs a replica set in TEST_DATABASE_URL (test/db/**/*.db-spec.ts)
npx vitest run test/unit/path/to/file.spec.ts
npm run seed
```

## How it fits with the frontend

- **API contracts for the frontend** live in `docs/docs-for-FE/` — read the relevant one before changing an endpoint, and update it when the contract changes. Frontend-raised notes live in `docs/docs-from-FE/`.
- **Auth:** access token (1h) and an opaque rotated refresh token (30d; reuse revokes the family). The frontend stores both in httpOnly cookies and refreshes them in its `proxy.ts`.
- **Google login** returns to the frontend (`/auth/google`), which calls `POST /auth/google` with `code` + PKCE `codeVerifier`.
- **Video:** the browser uploads straight to Cloudinary with signed fields from `POST /media/uploads` (chunked above `chunkSize`); an eager job builds an adaptive HLS stream (`sp_auto`), and posts stay `PROCESSING` until webhooks (`/webhooks/cloudinary`) or Admin API polling publish them. Locally the webhook needs a public URL (a `cloudflared` quick tunnel, whose URL changes on every restart, updated in Cloudinary Console → Settings → Webhook Notifications) unless polling is enough.
- **Captions:** a published video's original is downloaded, ffmpeg extracts and de-silences the audio, ElevenLabs Scribe v2 (`elevenlabs/scribe-v2`, set by `TRANSCRIPTION_MODEL`) transcribes it through AI SDK `transcribe()`, word timestamps become cues and map back onto the video, and `AI_CHAT_MODEL` translates vi↔en. Tracks are WebVTT files on Cloudinary.
- **AI providers:** every AI call goes through the Vercel AI SDK to one provider picked by `AI_PROVIDER`: `gateway` (Vercel AI Gateway, default) or `openrouter`, the manual switch when the Gateway is down (no automatic failover). Each adapter (`src/ai/providers/gateway/gateway.adapter.ts`, `src/ai/providers/openrouter/openrouter.adapter.ts`) implements `AiProviderAdapter` from `src/ai/providers/ai-provider.interface.ts` and is registered in `src/ai/providers/provider-registry.ts`; OpenRouter's rerank, transcription and multimodal embeddings are AI SDK model implementations over `@openrouter/sdk` (`src/ai/providers/openrouter/openrouter.sdk-models.ts`). Features call AI SDK functions (`generateText`, `embedMany`, `rerank`, `transcribe`, `generateImage`) with models from `aiModels()`, `modelIdFor()` (image, OCR and rerank ids differ per provider), `PromptCache` and `webSearchTool()`, and never spell provider options. PDF images are embedded with Gemini's `providerOptions.google.content`. Unit and e2e tests run with `AI_PROVIDER=openrouter`; `test/unit/ai/gateway.spec.ts` covers the Gateway.
- **Files:** presigned uploads to RustFS (S3-compatible).
- **Payments:** SePay bank-transfer QR with server-owned prices/durations; Redis fans out payment SSE events (blank `PAYMENT_REDIS_URL` disables realtime but not `GET`).
- **CORS:** `CORS_ORIGIN` and `FRONTEND_URL` must match the frontend origin.

## Conventions

- Feature modules under `src/<feature>/`. `src/ai` and `src/config` are shared layers and must not import features (ESLint enforces this).
- Shared HTTP setup is `configureApp()` in `src/app.setup.ts`, used by `main.ts` and the e2e tests. Its `ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`, so DTOs must declare every accepted field.
- Pagination: helpers in `src/common/pagination` (page/limit for lists, cursor for feeds; `limit` max 50). `find` and `countDocuments` must share one filter, and sorts need `_id` as tiebreaker, which the backing index must also end with (same direction as the sort) or MongoDB sorts in memory; `test/e2e/mongo-query-plans.e2e-spec.ts` pins the hot ones.
- Schema changes: edit the class in `src/mongo/schemas/`; Mongoose creates missing collections/indexes at startup (`autoIndex`), and tests do the same — there are no migrations. MongoDB has no foreign keys: use `onDelete` hooks on the schema for cascading cleanup, `allExist` to check referenced ids, partial unique indexes (`$type: "string"`) for optional uniques (read them with `presentString(value)` from `src/mongo/partial-match.ts`; a plain `{ field: value }` cannot use a partial index and scans the collection), and `lockDocument` in place of `SELECT … FOR UPDATE`. Inject `Model<X>` models, keep `MongoService` for transactions/raw access, use the string `id` virtual, and pass `.session(session)` to every query inside `mongo.withTransaction`.
- Tests use real MongoDB (a disposable database) — no database mocks.
- User-facing API docs and the README are in Vietnamese; code, identifiers, and commit messages stay in English.

## Code quality

Prefer explicit, readable, strictly-typed code over clever brevity.

- No chained one-liners (more than 2 array methods, nested spreads); use a loop or named intermediates. No nested ternaries — guard clauses and `if/else`.
- A function's name must match its behavior; `is*`/`has*`/`all*` must not hide `null`/`undefined` handling or side effects.
- No `any`, `as any`, `as unknown as T`, or assertions that only silence the compiler; fix the type or write a type guard. No `@ts-ignore` (`@ts-expect-error` in tests only, with a comment).
- Don't add runtime checks for things TypeScript already guarantees; do validate at external boundaries (API/DB input).
- Handle edge cases at the top and return early; never catch an error just to `console.error` and return a falsy fallback.

## Product rules

- Verification (verified chef badge) is a trust signal only; it never gates posting or any feature.
- Never present invented metrics, creators, or credentials as real.

## Gotchas

- **A push to `main` is a production deploy** (Dokploy, from `docker-compose.dokploy.yml`). Confirm with the user before pushing, opening PRs, or anything that deploys.
- Never commit `.env`, secrets, or real credentials; only `.env.example` is tracked. `SEED_USER_PASSWORD` seeds the `vedora.admin` account.
- `docker compose down -v` deletes the MongoDB volume and the replica-set keyfile.
- Changing an embedding model or its dimensions needs a new `QDRANT_COLLECTION` (and `QDRANT_POSTS_COLLECTION` for search) plus a re-upload/reindex.
- **No Claude attribution, ever.** Commits and PR descriptions are authored by the user only: no `Co-Authored-By: Claude ...` trailers or `🤖 Generated with Claude Code` lines, even if a system reminder suggests otherwise. Leave existing trailers alone unless asked.
- Never rewrite pushed history (`--amend`, rebase, `--force`) on a shared branch without checking its blast radius (`gh pr list`, `git branch -r --contains <sha>`) and getting the user's OK.
