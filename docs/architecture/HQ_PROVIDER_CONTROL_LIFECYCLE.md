# HQ AI provider control: read lifecycle and save receipts

Source: launch-readiness review pinned to main `0d476427`, findings [18] and [19]. The review says: "Shared HQ/provider snapshots lack session/privacy retirement and stale-read cancellation. Provider writes discard validated receipts, retain stale editor versions and create fresh keys rather than immutable unknown-outcome recovery." Owner instruction (David, 2026-11-22): fix the review's findings before more features. No migration, no API change.

## Problem (verified on main `bd8e1451`, `apps/web/src/components/hq-ai-provider-control.tsx`)

- Registry reads had no abort and no generation, so an older read could land after a newer one.
- Neither a session end nor a failed re-read cleared the shown registry. A failure kept the previous snapshot on screen.
- `postControl` made a new `Idempotency-Key` on every press. After a lost answer, pressing Save again was a new command.
- The server's receipt (`recordId`, `version`, `replayed`) was ignored. The editor kept the version it had before the save, so a later save, or a failed re-read, left it stale.

## Contract

- **PC1** Each registry read takes a new generation and aborts the previous read. Only the newest read, started in the current session epoch, can land.
- **PC2** A 401, a 403, an unreadable answer or a network failure retires the shown registry. HON never keeps a previous snapshot on screen as if it were still verified.
- **PC3** `HON_SESSION_INVALIDATED_EVENT` (and unmount) bumps the epoch, aborts the read, and clears the registry, every form, every held save and the preview. An answer that started before the session ended never lands.
- **PC4** `hq-ai-provider-commands.ts` freezes one request per save: its path, exact body and key.
  - A lost or unreadable answer (network failure, 5xx, 408, 429, `IDEMPOTENCY_IN_PROGRESS`, or a 2xx without an exact receipt) keeps the request. It locks that form and offers only **Retry the same save** or **Discard and edit again**.
  - Any other 4xx is definite: it drops the request, and the next save gets a new key.
- **PC5** Only an exact `{ data: { recordId, version, replayed } }` is a receipt:
  - the record id is the provider type for connections, and a UUID for catalog and policy records;
  - the version is a positive integer.

  The receipt moves the matching editor to the server's version before the registry is re-read. A replay says HON had already applied that exact save.
- **PC6** The route preview is a selection-only read. It no longer sends a key.

## Proofs

`apps/web/test/hq-ai-provider-lifecycle.test.tsx` covers:

- the command module's request, receipt and answer classes;
- a lost answer that locks the form, then a retry with an identical body and key, and the editor moving to version 2;
- a definite refusal that gives the next save a new key;
- a session end that retires everything, including a late answer that arrives afterwards;
- an older read that arrives late and is dropped.

Three of the four component tests fail against the old component.

## Not changed

- APIs, SQL and permissions.
- Catalog, policy and connection validation.
- The HQ shell's overview lifecycle. It is follow-up work, because it touches the same lines as #594.
