# Stage 3–5 local validation — 2026-09-06

## Implemented locally

- Supabase remains the only invitation mechanism: `/auth/confirm` uses the existing invite token exchange and `/onboarding` completes the invited user's password setup.
- Schema v2 adds per-user vault envelopes, encrypted entity shadows, user payment methods, ordering fields and `payment_method_id`.
- Schema v3 adds HKMA-compatible FX rate/snapshot storage; schema v4 adds encrypted AI preference/invocation foundations.
- Vault setup uses async scrypt (`N=2^17`, `r=8`, `p=1`), AES-256-GCM, owner/entity AAD, HKDF-derived keys and owner-scoped HMAC blind indexes. Sessions are in-memory with 15-minute idle and 8-hour absolute TTLs.
- Transaction, metadata, analytics and export paths require an unlocked vault after initialization. Sensitive transaction/profile/AI fields are decrypted from shadows; plaintext SQLite columns contain only redacted sentinels and routing structure.
- User metadata supports accounts, categories, channels and custom payment methods. Categories enforce two levels and same-owner/same-kind parents. Legacy payment codes remain accepted for one compatibility release.
- `/api/analytics/summary?month=YYYY-MM` derives a user-timezone month boundary. The UI supports previous/current/next month switching with abortable requests.
- FX conversion uses integer rational arithmetic with half-up rounding. HKMA parsing/fetching is isolated in an adapter and rejects future dates.
- DeepSeek and MiniMax adapters have separate official HTTPS hosts, keys, models and request behavior. User opt-in is stored per user; AI invocations reserve quota in SQLite before network calls and record `reserved/running/succeeded/failed/unknown`.

## Checks

- `npm run check`: passed — 10 Vitest files, 35 tests, lint, typecheck and Next.js production build.
- Sensitive-information scan: no live API keys, Supabase tokens, database files or user records were added to the working tree.
- Docker daemon/production Ubuntu/Supabase/real HKMA/DeepSeek/MiniMax smoke tests were not run; those remain deployment/administrator-authorized acceptance tasks.

## Known bounded limitations

- Secure-mode grouped transfers are rejected pending a dedicated encrypted pair implementation; existing pre-vault transfers remain readable after migration.
- The HKMA adapter is unit-tested with synthetic payloads; live network retrieval and weekend prior-date fallback require an administrator-controlled smoke test.
- The AI settings API is implemented; the current settings screen still exposes the existing high-level AI status and can be extended with the provider consent controls without changing the server boundary.
