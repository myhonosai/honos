# HQ shell gate for support-only accounts

Source: launch-readiness review pinned to main `0d476427`, finding [17] ("the shared overview gate blocks legitimate SUPPORT users even though support API/SQL authorization permits them... Correct these without broadening support disclosure"). Owner instruction (David, 2026-11-22): fix the review's findings before more features. No migration, no API change.

## Problem (verified on main `bd8e1451`)

- `HqModernShell` wraps every `/hq` page and opens a page only after `GET /api/v1/hq/overview` succeeds.
- `HqOverviewService` allows the overview only for `HON_HQ_OWNER` and `HON_HQ_OPERATOR`.
- The support API (`hon.hq_support_principal_eligible`, 0232) also admits `HON_HQ_SUPPORT` with `hq.support.manage`, and so does the communications API (`hon.hq_communication_purposes`, 0281). Those accounts got "HQ access denied" before Support could load.

## Contract

- **SG1** An overview `403` puts the shell in a `limited` state. That state is "no overview authority", not "no HQ authority". A `401` still asks the person to sign in. Any other failure is still "unavailable".
- **SG2** In `limited`, the shell opens only the pages that `hqPageAuthorizesItself` lists, which is an exact list:
  - `/hq/support` and `/hq/support/<uuid>`;
  - `/hq/communications` and `/hq/communications/<uuid>`.

  Those pages call APIs that decide HQ authority on every read and command. Every other page, including the dashboard and `/hq/communications/numbers`, shows the denial, with links to Support and to Texts & Email.
- **SG3** Nothing is disclosed beyond what those APIs already return to the account:
  - a `limited` page gets no overview context;
  - it gets no HON assistant and no launcher;
  - it gets no other page.

  An account with no HQ grant at all reaches the same two pages, and their own APIs refuse it.
- **SG4** The overview API, the support API, the communications API and the session layout gate are unchanged.

## Proofs

`apps/web/test/hq-shell-support-gate.test.tsx` drives the real shell through a hook runner and checks:

- after an overview `403`, the four self-authorizing paths render their page, with no overview context and no assistant;
- after the same `403`, six other paths show the denial and the Support link;
- a `401`, an unavailable overview, and a still-loading overview each open no page, Support included;
- the path list is exact.

Full web suite: 3661 tests passed. Web `tsc` is clean. The design-system `tsc` is clean, with three new translated strings in en, es and ko.

## Overview read lifecycle (review [18], HQ shell part)

The shell holds one overview read at a time. A newer access check ("Check access again", "Refresh HQ access") aborts
the older read, and only the newest read's answer can land. A confirmed session end (`hon:session-invalidated`)
aborts any read still out and retires the overview, the HON assistant, its draft and the menu; the shell shows
"Sign in to verify HQ access" and opens no page, Support included, until a new check verifies a fresh overview. Late
answers from before the session end are dropped. Proof: `apps/web/test/hq-shell-lifecycle.test.tsx` (three of its four
cases fail on the earlier shell). The unreachable `forbidden` state was removed; a 403 is `limited`.
