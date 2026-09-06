# Stage 6 acceptance boundary — 2026-09-06

The application is ready for the administrator-controlled acceptance sequence:

1. Install a fresh SQLite database and run v1→v2→v3→v4 migrations; verify migration ledger checksums and foreign keys.
2. Invite two users through the existing Supabase dashboard flow, complete `/auth/confirm` and `/onboarding`, and run the cross-owner negative matrix.
3. Run the single-node Ubuntu Docker migrator, application and Caddy HTTPS stack; verify mobile access, PAT expiry/disablement, vault lock and temporary unlock.
4. With synthetic data only, explicitly trigger HKMA, DeepSeek and MiniMax smoke tests; never send real partner ledger data during acceptance.
5. Perform encrypted database and backup restore, then rerun owner isolation and known-plaintext scans.

Local evidence on this host: lint, typecheck, 35 tests and production build pass; Compose YAML parses. Docker daemon access, live Supabase, HTTPS, backup restore and provider network smoke tests were unavailable or intentionally not run. No production `.env`, real user migration, remote push, or deletion of v1 plaintext backups is performed automatically.
