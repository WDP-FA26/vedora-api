# Backend runtime configuration

BE externalizes operational settings into env. Defaults preserve the previous behavior. Existing API request/response fields remain compatible at default settings.

## Public limits

> **Trạng thái:** Endpoint `GET /api/v1/public-config` hiện đang được tạm khóa (`DisabledEndpointGuard`, trả `404 NOT_FOUND` và ẩn khỏi Swagger `/docs`) do FE chưa tiêu thụ.

`GET /api/v1/public-config` (adjust API_PREFIX if configured) requires no authentication and returns `Cache-Control: no-store`.

Response groups:

- `version`: hash of the public configuration only; changes when a public value changes.
- `timeZone`: configured reporting/subscription timezone; default `Asia/Bangkok`.
- `auth`: username/name/password input limits and OTP length.
- `content`: post/blog/comment/message/recipe UI input limits.
- `uploads`: profile/blog/proof upload limits supported by the backend.
- `ai`: allowed message counts, message length, editor selection length and supported image aspect ratios.
- `pagination`: normal/admin page sizes and maximum report interval.
- `payment`: new-order TTL in seconds and payment-code suffix length.

Example subset (the actual response includes all groups):

```json
{
  "version": "<16-character-config-hash>",
  "timeZone": "Asia/Bangkok",
  "auth": { "usernameMinLength": 3, "usernameMaxLength": 30, "fullNameMaxLength": 100, "passwordMinLength": 8, "otpLength": 6 },
  "payment": { "ttlSeconds": 1800, "codeSuffixLength": 6 }
}
```

No API keys, credentials, model prompts, policy files or private deployment configuration are returned. Do not serialize ConfigService or process.env into a frontend response.

## FE follow-up

Endpoint `GET /api/v1/public-config` hiện đang tạm khóa bằng `DisabledEndpointGuard` (`404 NOT_FOUND`, ẩn khỏi Swagger `/docs`). FE vẫn dùng các hằng số cục bộ cho tới khi mở lại endpoint này để tiêu thụ trực tiếp. Before increasing/decreasing public limits in production, re-enable this endpoint and update FE to consume it and build Zod/form schemas from the returned values. In particular, FE currently assumes six OTP digits, fixed post/recipe limits and a fixed VietQR origin; custom env values can require FE changes and a CSP update.

`MAX_VIDEO_DURATION_SEC` already comes from existing BE env, while the current FE has a fixed 180-second input check. This setting is not included in this endpoint yet; FE must coordinate any change to that existing env. The recipe-image 10 MB and blog-video 100 MB frontend-only caps have not been misrepresented as new backend enforcement.

For moderation queue colors, use the effective settings from the authenticated Admin moderation settings endpoint. Saved DB settings override default env thresholds and policy files; a default value is not necessarily the active policy.

Read each payment's own `expiresAt` and each purchased cycle's own limits. Do not recompute an old order's deadline using the new global `ttlSeconds`.

Guest chat still has a backend per-message context cap of 2000 characters and a frontend input cap of 500 characters. This refactor does not silently make them identical.

## Deployment

Env is read once at startup, including from `.env`, before DTO decorators and scheduler registration. Restart the API after editing env. FE NEXT_PUBLIC values remain build-time configuration; server credentials never become NEXT_PUBLIC variables.

See [BE_ENV_REFERENCE.md](../BE_ENV_REFERENCE.md) and `.env.example` for every new setting and its exact default.
