# HON OS — Agent Instructions

This repository is the active, security-sensitive HON OS codebase. **Read [`docs/EXTERNAL_AGENT_HANDOFF.md`](docs/EXTERNAL_AGENT_HANDOFF.md) before proposing or making any change.** It contains the authoritative collaboration workflow, product boundaries, architecture map, validation commands, safety constraints, known gaps, and a copy-ready prompt for Claude or other agents.

## Mandatory first reads

1. [`docs/EXTERNAL_AGENT_HANDOFF.md`](docs/EXTERNAL_AGENT_HANDOFF.md)
2. [`docs/HON_MASTER_DIRECTIVE.md`](docs/HON_MASTER_DIRECTIVE.md)
3. [`TODO.md`](TODO.md)
4. The exact relevant operating contract under `docs/architecture/` or `docs/`

## Non-negotiables

- Preserve multi-tenant organization/school isolation, forced RLS, least privilege, current principal/scope checks, audit/outbox/idempotency, and HQ/staff/family separation.
- Conventional UI and canonical domain services come first. Never create a parallel data model, AI-only service, raw SQL path, generic mutation endpoint, or UI-derived authority.
- AI must use the governed Action Engine route; visual mode/avatar choice is presentation only.
- Do not make paid/provider calls, activate payments, send communications, deploy, mutate a remote/shared database, or expose/commit secrets without explicit owner approval.
- Treat URL/form/UI values as untrusted selectors. They cannot auto-fetch, auto-command, confer authority, or establish a record fact.
- Read the current state before modifying it; use focused tests plus appropriate broader checks; update `TODO.md` only with actual evidence.
- GitHub `main` is canonical. Prefer a focused branch/PR, never force-push or rewrite history. A push is not a deployment; auto-publish is disabled.

## Core validation

```bash
pnpm test
pnpm check
pnpm build
git diff --check
```

Use project-provided disposable-local database proofs for database work. Do not point fixtures or migrations at a remote/shared database.
