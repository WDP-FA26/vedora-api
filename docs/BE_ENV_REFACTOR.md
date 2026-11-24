# Backend env refactor

Chuyển 259 tham số vận hành của BE sang env, giữ giá trị mặc định theo code trước khi refactor. Xem bảng đầy đủ tại [BE_ENV_REFERENCE.md](BE_ENV_REFERENCE.md) và các dòng cấu hình có thể sao chép trong `.env.example`. Chưa thay đổi code FE.

Các giá trị chính được giữ nguyên: Plus 49000 VND, Pro 99000 VND, chu kỳ 30 ngày, đơn thanh toán 1800 giây; hạn mức Plus 300 lượt chữ/10 ảnh và Pro 900 lượt chữ/40 ảnh. Giá và chu kỳ đã có env từ trước và vẫn dùng tên biến cũ.

The operational settings introduced here preserve the values used by the previous backend. Units are explicit: `_SECONDS`, `_MS`, `_MB` (1024*1024 bytes), and six-field cron expressions. Existing env names for provider credentials, model selection, pricing, subscription duration, video duration and knowledge-file size remain supported.

## Loading and validation

`src/config/runtime-defaults.ts` is the single catalogue of new defaults. `runtime-settings.ts` validates numeric/string values and related bounds without reading or mutating process.env. `runtime-config.ts` loads dotenv and takes an immutable startup snapshot before any request DTO decorator or cron is evaluated. `validateEnvironment()` also exposes the parsed operational values through Nest ConfigService.

This intentionally uses a startup snapshot rather than a mutable global configuration or a request-specific setting: DTO metadata, service behavior and the registered scheduler must agree. Env changes require restart. Tests that vary startup env load a fresh module graph.

Invalid values stop startup, including empty/NaN/fractional integer limits, invalid cron/timezone/URL, unsupported OCR response-parser engine, out-of-range bcrypt/OTP/code lengths and inconsistent page/report/search limits.

## Exact defaults

After integrating `main` at `b6d221715fc61166f82e16b88d5add0b87047319`, four defaults follow the newer upstream implementation. Explicit env overrides still take precedence:

| Setting | Initial refactor baseline | Integrated main default |
| --- | --- | --- |
| `AI_DECISION_TIMEOUT_MS` | 4000 | 10000 |
| `MEAL_PLAN_MAX_DISHES_PER_SECTION` | 6 | 5 |
| `MEAL_PLAN_SUGGESTIONS_LIMIT` | 30 | 60 |
| `PLANNER_CHAT_MAX_STEPS` | 8 | 10 |

The planner prompt file now contains the latest upstream draft-editing instructions. Both moderation model defaults follow upstream `openai/gpt-6-luna-decisions`, including Compose forwarding. Audit fixtures retain their initial values/hashes and explicitly record upstream replacements and the source revision; they do not silently rewrite the original evidence. Recipe tags, generation/editing tools, draft conflict handling, moderation latency logs and Admin quota behavior from main are retained.

`test/fixtures/runtime-defaults-before-refactor.json` records 156 scalar constants evaluated from the old source, with file/name and any unit multiplier. A regression test checks every one against the new defaults. DTO override tests verify that the new values actually affect validation, generation, scheduling and public responses.

Additional defaults were checked at their call sites: AI-cost pagination remains 50 (ordinary Admin payments pagination remains 25), guest quota resets in UTC, reporting/subscription dates use Asia/Bangkok, and moderation receives at most 24000 history characters by default. No default budget, token count, model or timeout was silently increased.

Policies were extracted to `config/policies/*.json` from their original literal values, and an env variable selects each file. System prompts live in TypeScript next to their feature (`*.prompt.ts`). Prompts keep dynamic user/editor/recipe context in their existing builders. Invalid/missing/empty config files stop startup. Files are copied into both the build and runtime Docker stages; custom files can be mounted into the API container.

## Historical data and invariants

- New purchases snapshot env-selected catalogue allowances and order TTL.
- An existing order with expiresAt keeps that deadline. An older order without expiresAt keeps the historical 30-minute rule, rather than acquiring a different deadline when env changes.
- Purchased allowance snapshots stay unchanged. Rows created before allowance snapshots existed keep the historical Plus 300/10 and Pro 900/40 contract; changing current catalogue env does not rewrite them.
- Calendar units, protocol field names, roles/statuses, PLAN_VERSION, ownership checks, signature verification, exact-payment matching, transaction/unique-index behavior and bcrypt's 72-byte algorithm limit are invariants, not configuration switches.
- Production explicitly requires a non-test TURNSTILE_SECRET_KEY. Local development/test can still use the documented dummy key. This fixes the earlier production fallback to a public testing secret; it does not generate or guess a real production secret.

## Scope and remaining work

Only the backend is changed. Public UI limits are available at `GET /public-config`; FE adaptation is tracked separately. File-size assumptions enforced only by the old frontend have not been claimed as backend enforcement. Changing a provider endpoint also requires corresponding deployment/CSP compatibility on FE.

This refactor does not fix existing issues in knowledge heading parsing, bookmarks/follow pagination, notification deduplication or malformed storage webhook handling. Moving the knowledge timeout to env is not an indexRunId/state-transition fix. The moderation/model context mismatch is also not claimed fixed: the existing 24000-character moderation budget is now configurable, while input behavior is preserved as requested.

`APP_TIMEZONE` applies to report boundaries, aggregation buckets and Free subscription calendar periods. SePay transactionDate is still interpreted as UTC+7 because that is the bank webhook format, not an application display preference. `GUEST_QUOTA_TIMEZONE` defaults to UTC to preserve existing behavior.

## Docker and operations

Docker Compose explicitly maps all new keys with the same defaults as `.env.example`, including when values are supplied as shell env. No real .env or credentials are committed. Build/runtime images include config files. Restart the API after changing operational env; deploy compatible FE consumption before changing UI-facing limits from their defaults.

See [BE_ENV_REFERENCE.md](BE_ENV_REFERENCE.md) for all keys and values, and [docs-for-FE/runtime-config.md](docs-for-FE/runtime-config.md) for the public contract.

## Validation

- Node 26.12.1 build and ESLint pass. The production Docker image builds successfully.
- Full unit run: 1252 pass, 10 fail across 161 files. All 41 configuration tests present in that run pass. A final regression for changing the profile cleanup batch size was then added; the targeted run passes 67 tests, including all 42 configuration tests. The remaining full-run failures match the pre-refactor baseline: notification fan-out/unread (3), bookmark pagination (1), follow pagination (1), knowledge heading parsing (3), malformed storage webhook handling (2). Four initial baseline ffmpeg failures disappeared after installing the missing local binary; they were not code fixes in this change.
- Payment/subscription/Admin payments/AI-cost database suites: 121 tests pass.
- Docker production-mode API smoke uses isolated Mongo/Redis fixtures and env overrides. It verifies public config secret exclusion/no-store, DTO limits, persistence of a 2500-character message under a 3000-character configured limit, rejection above that limit, unchanged 49000/30 pricing/duration, changed new-order TTL/code/allowances, idempotency and ownership, unattended cron expiration, late callback receipt, successful payment, purchased and historical allowance contracts, and CSV row cap. No real payment, paid AI call or production CAPTCHA request is made.
- All 259 new env defaults match `.env.example` and Compose. All 156 captured scalar constants and the hashes of the three original prompts/three policy objects are checked. Compose shell override forwarding is verified.
- FE code remains unchanged. These checks validate implementation on the feature branch; they do not mean it has been merged or deployed.

The main-integration follow-up was checked separately: 302 relevant unit tests across 47 files and all 48 meal-plan flow E2E tests pass. Build, ESLint, production Docker build and the env-override Docker API smoke pass again. All 259 defaults still match Compose and `.env.example`. The integration resolves eight conflicted files on the feature branch; it does not merge the feature branch into main or deploy it. The earlier full-unit baseline result above is historical and was not represented as a fresh full-suite run for this follow-up.
