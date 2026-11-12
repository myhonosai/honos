#!/usr/bin/env bash
# Runs a focused set of HON PostgreSQL security/integrity proofs against a DISPOSABLE local
# PostgreSQL on localhost:5432. It reuses the repository's own guarded setup scripts unchanged:
# each one creates a marked, dedicated database and least-privilege owner/runtime roles, applies
# every migration, and writes generated credentials to a private mode-0600 file.
#
# Safety:
# - Runs only on an ephemeral GitHub-hosted runner, or locally with HON_DB_PROOFS_LOCAL=1.
# - Never reads or accepts a DATABASE_URL; the setup scripts refuse anything but localhost:5432.
# - Every setup/proof runs under `env -i` with only PATH/HOME/LANG, so no token, provider key,
#   or CI credential is visible to it (the scripts also refuse such variables themselves).
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  [[ "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]] || { echo "Refusing: database proofs run only on ephemeral GitHub-hosted runners." >&2; exit 1; }
elif [[ "${HON_DB_PROOFS_LOCAL:-}" != "1" ]]; then
  echo "Refusing: set HON_DB_PROOFS_LOCAL=1 to run against your own disposable localhost:5432 PostgreSQL." >&2
  exit 1
fi
if [[ -n "${DATABASE_URL:-}" || -n "${HON_RUNTIME_DATABASE_URL:-}" ]]; then
  echo "Refusing: unset DATABASE_URL/HON_RUNTIME_DATABASE_URL; fixtures generate their own disposable credentials." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="$repo_root/packages/database/scripts"
# The setup scripts only write credentials beneath this private job root.
job_dir="/home/ubuntu/jobs/ci_db_proofs"
if [[ ! -d "$job_dir" ]]; then
  sudo mkdir -p "$job_dir"
  sudo chown "$(id -u):$(id -g)" /home/ubuntu /home/ubuntu/jobs "$job_dir"
fi
chmod 700 "$job_dir"
rm -f "$job_dir"/*.env
# Remove generated disposable credentials on every exit path, including failures.
# The adult CRM draft fixture owns a nested private cluster, so also clean its
# mode-0600 environment file and stop its process even when its proof fails.
adult_draft_dir=''
cleanup() {
  rm -f "$job_dir"/*.env "$job_dir"/*/*.env
  if [[ -n "$adult_draft_dir" && -d "$adult_draft_dir/pgdata" ]]; then
    /usr/lib/postgresql/16/bin/pg_ctl -D "$adult_draft_dir/pgdata" -m fast -w stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

clean_env=(env -i "PATH=$PATH" "HOME=$HOME" "LANG=C.UTF-8")
passed=0
summary=()

setup() { # name, target-variable, database, env-file-variable
  local name="$1" target_var="$2" database="$3" file_var="$4"
  echo "::group::Provision disposable fixture: $name"
  "${clean_env[@]}" "$target_var=postgresql://localhost:5432/$database" "$file_var=$job_dir/$name.env" \
    node "$scripts/setup-$name-validation.mjs"
  echo "::endgroup::"
}

proof() { # fixture, script, description
  local fixture="$1" script="$2" description="$3"
  echo "::group::$description ($script)"
  # shellcheck disable=SC2016 # positional parameters are expanded by the inner shell on purpose
  "${clean_env[@]}" bash -c 'set -a; . "$1"; set +a; cd "$2" && node "scripts/$3"' _ "$job_dir/$fixture.env" "$repo_root/packages/database" "$script"
  echo "::endgroup::"
  passed=$((passed + 1))
  summary+=("| $description | \`$script\` | pass |")
}

# AI-0 spend-authority regression baseline (test only, no fix). Single-use dedicated fixture with
# fake providers only; known failures KF-AI2/AI9/AI14/AI8/AI3 pass only while they reproduce exactly as
# pinned OPEN in ai-spend-entrypoints.json and must be replaced by S4 (or the approved AI-D3 slice).
setup ai-spend-baseline HON_AI_SPEND_BASELINE_VALIDATION_TARGET hon_ai_spend_baseline_validation HON_AI_SPEND_BASELINE_ENV_FILE
proof ai-spend-baseline test-ai-spend-authority-baseline.mjs "AI-0 spend-authority baseline: strict inventory of AI spend paths, grants and ceilings; closed credit/trial/access/payment programs; entitlement gates for all three agents; 5 known failures (open, replaced by S4 or a later approved slice)"

# Public lead forms use the uniquely marked marketing fixture. Keep its descriptor
# separate from every other proof and invoke the package's existing db:test-public-forms
# command so it builds the current contracts/config/database/API before both proofs.
public_forms_fixture='public-lead-forms'
echo "::group::Provision disposable fixture: $public_forms_fixture"
"${clean_env[@]}" \
  HON_CAMPAIGN_VALIDATION_TARGET=postgresql://localhost:5432/hon_campaign_validation \
  HON_CAMPAIGN_ENV_FILE="$job_dir/$public_forms_fixture.env" \
  node "$scripts/setup-marketing-validation.mjs"
echo "::endgroup::"
echo "::group::Public lead forms: current-school monitor, signed session, lifecycle and ingress integrity"
# shellcheck disable=SC2016 # descriptor is sourced only inside the clean subprocess.
"${clean_env[@]}" \
  HON_CAMPAIGN_VALIDATION_TARGET=postgresql://localhost:5432/hon_campaign_validation \
  bash -c 'set -a; . "$1"; set +a; cd "$2" && pnpm --filter @hon/database db:test-public-forms' _ "$job_dir/$public_forms_fixture.env" "$repo_root"
echo "::endgroup::"
passed=$((passed + 1))
summary+=("| Public lead forms: current-school monitor, signed session, lifecycle and ingress integrity | \`db:test-public-forms\` | pass |")

setup class-sessions-read HON_CLASS_SESSIONS_READ_VALIDATION_TARGET hon_class_sessions_read_validation HON_CLASS_SESSIONS_READ_ENV_FILE
proof class-sessions-read test-security-boundaries.mjs "Tenant isolation, restricted runtime role, parent-family boundaries"
proof class-sessions-read test-outbox-leases.mjs "Outbox leases never treat UNKNOWN as published"
proof class-sessions-read test-class-sessions-read-integrity.mjs "Class Sessions current-school read boundary"
proof class-sessions-read test-class-sessions-read-microsecond-order.mjs "Class Sessions read: signed-session HTTP 200 and one (published millisecond, UUID) order across SQL, 50-row boundary and contract"

setup crm-lead-close HON_CRM_LEAD_CLOSE_VALIDATION_TARGET hon_crm_close_validation HON_CRM_LEAD_CLOSE_ENV_FILE
proof crm-lead-close verify-rls.mjs "Forced RLS on every tracked operational table"
proof crm-lead-close test-crm-lead-close-integrity.mjs "CRM lead close authority, atomicity and replay"
proof crm-lead-close test-crm-trial-appointment-integrity.mjs "CRM trial appointments: one active trial per lead (new-key, cross-tab, concurrent), exact-key replay before the clock rule, direct-human reconciliation reads, revocation, outcome integrity"
proof crm-lead-close test-crm-list-pagination-integrity.mjs "B-CRM-4 list pagination over signed HTTP: guarded disposable target (socket-free guard negatives first), CRM lead list and people directory page through every exact-school row once in a stable keyset order (microsecond ties broken by id), HMAC-signed fixed-size cursors bound to list, school and filter, tampered/retargeted/over-long cursors and edited anchors refused, Korean boundary names, page two refused after permission loss or suspension, zero effects"
proof crm-lead-close test-class-session-roster-integrity.mjs "U5 class-session roster over signed HTTP: guarded disposable target, every booked or walk-in student of the exact session and school once in (family, given, id) order at several page sizes, only that session's booking and attendance, signed cursors bound to the session, edited anchors refused, attendance.record required, page two refused after permission loss or school/organization/entitlement suspension, zero effects"
proof crm-lead-close test-school-membership-list-integrity.mjs "U6 school membership list (0220) over signed HTTP: guarded disposable target, every exact-school membership once in (created_at, id) order including microsecond ties, reporting status equal to the 0178 history read, state filter, signed cursors bound to school and filter, three admitting permissions with an independent definer decision, page two refused after permission loss or school/organization/entitlement suspension, runtime ACL, zero effects"
proof crm-lead-close test-class-session-pages-integrity.mjs "Forward-paging class-session list (0221) over signed HTTP: guarded disposable target, runtime without class_sessions SELECT, every exact-school session from a school-local date (default today) once in (published millisecond, id) order including millisecond ties and sessions beyond 91 days, facts equal to the bounded 0147 read, signed cursors bound to school and from date, strict browser transport, schedule.session.read with an independent definer decision, page two refused after permission loss or school/organization/entitlement suspension, zero effects"
proof crm-lead-close test-membership-pause-integrity.mjs "Membership pause, cancellation and refund records (0224) over signed HTTP: guarded disposable target, per-school versioned pause policy with exact replay, staff-only pause/resume bound to one pause row by the settings-free transition trigger with unchanged term dates, per-pause and per-365-day limits, active payment schedules block a pause, immediate cancellation also from a pause, legacy FROZEN refused without evidence, refund records for cancelled memberships only, live permission/school/entitlement loss refused, strict browser transport, runtime EXECUTE-only ACL, no invoice/payment/schedule change"
proof crm-lead-close test-student-import-integrity.mjs "Student and guardian CSV import (0226) over signed HTTP: guarded disposable target, strict CSV parse and closed mapping, every cell, minor/guardian rule and family-key grouping revalidated in the database, advisory duplicate suggestions never merged, stage/decide/finalize with exact replay and an exact selection on the current version, people/families/family links/student profiles only (no membership, account, invoice, schedule, enrollment, booking, lead or portal access), identifier-only audit and inert outbox, live permission/school/entitlement loss refused, settings-free evidence guard, runtime EXECUTE-only ACL"
proof crm-lead-close test-crm-school-clock-integrity.mjs "CRM school clock (0236, B-CRM-3) over signed HTTP: the session school's IANA timezone and local today for CRM time entry; any CRM trial or follow-up permission live at the exact school with paid access, re-checked after the read; family-type roles, other school/organization, suspended access, revoked grants and browser transport refused; writes nothing; runtime EXECUTE on the read only; 011 section"
proof crm-lead-close test-class-series-integrity.mjs "Recurring class series (B-SCH-1, 0239) and ongoing series (B-SCH-2, 0251) over signed HTTP: manager-only ongoing switch (off by default, on fills 84 days ahead) and page top-up of due ongoing series only, guarded disposable target, weekly series in school time with manage-only create/revise/end/fill and read-only weekly timetable (Monday-Sunday school week), explicit fill capped at 12 weeks with DST-gap dates skipped, booked or attended sessions never moved or cancelled, revise and end cancel only unbooked future sessions, exact replay and key reuse, stale version and ended-series refusals, live permission/school/entitlement loss refused, strict browser transport, settings-free series and occurrence triggers, runtime EXECUTE-only ACL, 011 section, no change to sessions outside a series"
proof crm-lead-close test-tuition-payment-integrity.mjs "Tuition payment records (B-TUI-1, 0240) over signed HTTP: guarded disposable target, unpaid balances (open/overdue, per-currency totals, id cursor) for record/issue/create staff only, partial payments against ISSUED current-school invoices with version, currency, future-date and overpayment refusals, PAID when covered, void with a reason returns PAID to ISSUED, exact replay and key reuse, one concurrent winner, live permission/school/entitlement loss refused, strict browser transport, settings-free record and invoice-status triggers, runtime EXECUTE-only ACL, 011 section, no other invoice/payment/refund change"
proof crm-lead-close test-school-payment-connections-integrity.mjs "School payment processor connections (B-TUI-2 piece 1, 0258) over signed HTTP with in-process Stripe Connect and Square simulators: guarded disposable target, provider registry never live, TEST-only connections, start/onboarding link/finish/refresh/default/disconnect, one-time onboarding state stored only as SHA-256 and never persisted raw, state derived from provider observations (active/restricted/reauthorization), capabilities narrowed by the adapter, one open connection per provider, one ACTIVE default, provider account linked inside one organization only, exact replay and key reuse, live permission/school/entitlement loss refused, strict browser transport, settings-free guards, runtime EXECUTE-only ACL, 011 section, no payment attempt or invoice"
proof crm-lead-close test-school-checkout-pages-integrity.mjs "School checkout page settings (B-TUI-2 piece 9a, 0269) over signed HTTP: guarded disposable target, school_checkout.manage only, enrollment and tuition pages as draft or published, closed content shape (plans in order, add-ons, custom questions, waiver, receipt and thank-you text in EN/KO/ES), only available plans of this school, published enrollment needs a plan, optimistic version, exact replay and key reuse, live permission/school/entitlement loss refused, append-only versions, settings-free guards, runtime EXECUTE-only ACL, 011 section, no payment attempt or invoice"
proof crm-lead-close test-platform-least-privilege.mjs "Platform least privilege: nothing in schema hon reachable through PUBLIC or Supabase client roles; injected regressions rejected"
proof crm-lead-close test-migration-runner-safety.mjs "Migration tooling: single-runner lock, read-only db:status (current, divergent history), TLS refusal before connecting"
proof crm-lead-close test-restore-drill.mjs "Backup/restore drill: pg_dump, total loss, pg_restore, identical data/ledger/security posture, verifiers pass on the restored database"

# Database TLS verification needs its own private TLS-only cluster (no fixture descriptor).
echo "::group::Database TLS verification against a private TLS-only cluster (test-database-tls-verification.mjs)"
"${clean_env[@]}" HON_DB_PROOFS_LOCAL=1 bash -c 'cd "$1" && node scripts/test-database-tls-verification.mjs' _ "$repo_root/packages/database"
echo "::endgroup::"
passed=$((passed + 1))
summary+=("| Database TLS verification: configured CA required, wrong CA and host mismatch refused, URL TLS overrides refused | \`test-database-tls-verification.mjs\` | pass |")

# Communication delivery (0243) has its own fixture with the canonical 013 worker login.
setup communication-delivery HON_COMMUNICATION_DELIVERY_VALIDATION_TARGET hon_comm_delivery_validation HON_COMMUNICATION_DELIVERY_ENV_FILE
proof communication-delivery test-communication-delivery-integrity.mjs "Communication delivery and receipts (0243): worker-only claim/lease/record functions, SMS quiet hours in school time, consent and address re-checked at send time, retry backoff and exhaustion, lease expiry and late results UNKNOWN (never retried), idempotent forward-only provider receipts, unsubscribe and spam report record OPTED_OUT/RECIPIENT, suspended school held, forced-RLS school read without address or provider IDs, dispatcher end to end through the fake provider"

setup champions-club HON_CHAMPIONS_VALIDATION_TARGET hon_champions_validation HON_CHAMPIONS_ENV_FILE
proof champions-club test-a2p-preparation-integrity.mjs "A2P-1: read-only exact-school owner-confirmed registration preparation, live IAM/entitlement checks, signed-session API/database, no public fetching or provider/consent/message effects"
proof champions-club test-champions-club-integrity.mjs "Champions Club authority, attribution, qualification gates and evidence"
proof champions-club test-champions-club-rewards-integrity.mjs "Champions Club reward accounting: liabilities, approvals, reversals, no billing effect"
proof champions-club test-champions-club-leaderboard-integrity.mjs "Champions Club leaderboards: qualified-only standings, privacy, holds, statistics"
proof champions-club test-champions-club-contests-integrity.mjs "Champions Club contests: HQ lifecycle, frozen standings, winner review, liabilities"
proof champions-club test-champions-club-journey-integrity.mjs "Champions Club end-to-end journey: code to winner, automatic reward reconciliation, audit"
proof champions-club test-saas-subscription-integrity.mjs "HON subscription catalog (B1): owner-only offers, atomic founder inventory, entitlement-linked records, no billing effect"
proof champions-club test-saas-billing-utc-periods-integrity.mjs "Issue #100 (0201): SaaS billing periods are UTC calendar months from the original anchor (month-end clamping, leap years, DST, time of day) whatever the session, database default or reused pooled connection TimeZone; pre-0201 drift reproduced only with the pin removed"
proof champions-club test-saas-billing-utc-webhook-periods.mjs "0201 on the production webhook path: monthly and annual HON OS activation and renewals at month ends, a leap day and DST days on one reused pooled session across zones and a non-UTC database default; pre-0201 drift reproduced only with pins removed; read-only operator checks find exactly the drifted rows"
proof champions-club test-saas-invoicing-integrity.mjs "HON invoices and payment evidence (B2): gapless numbering, verified tax before issue, HQ attestation only, no collection or reward effect"
proof champions-club test-saas-credits-integrity.mjs "HON premium credits (B3): owner-gated program, verified-cost pricing, reserve/finalize/release/expire ledger, concurrency-safe balance"
proof champions-club test-saas-creative-wallet-integrity.mjs "HON OS creative credit wallet (CW1, 0202): school-owned wallets: 12,000 monthly window per eligible paid HON OS school, separate from the agent budget; HQ-owner rates/grants/corrections; concurrency-safe reserve/settle; actual provider cost recorded separately; top-up intents and TEST MODE exactly-once fulfillment; no provider call, no card charge"
proof champions-club test-saas-creative-wallet-review-regressions.mjs "CW1 review regressions: exact-school isolation for two schools in one organization; school-owned allowances, purchases and locks; S4 HQ pause/access refuse new reservations but never accounting; CREATIVE_MEDIA expense separate in HQ usage; unknown provider cost stays UNKNOWN and is recorded exactly once"
proof champions-club test-saas-creative-wallet-no-subscription.mjs "Creative wallet (0209): a school with no SaaS subscription reads its own wallet (no SQLSTATE 55000); INACTIVE zero posture, intended refusal reason, authorization and invoker posture unchanged, nothing written"
proof champions-club test-creative-studio-generations.mjs "Creative Studio generations (CS1, proposed 0216): reserve from the exact school's creative wallet, one synthetic provider call, one settlement; actual units charged, failures released, unknown held for the HQ owner; idempotent replay, 3-in-progress fair-use cap, S4 pause, exact-school isolation, CREATIVE_MEDIA cost with zero customer credits; authority, S4 decision and eligibility re-decided after the generation write (no stale grant or entitlement reaches the provider); no provider, payment or AI-team charge"
proof champions-club test-saas-refunds-rewards-integrity.mjs "HON refunds and Champions rewards (B4): 30-day first-purchase guarantee records, owner-gated reward application, alerts block fulfillment, no execution or payout"
proof champions-club test-saas-payments-integrity.mjs "HON payments (B5, test mode, simulated Stripe): hosted checkout, signature-verified idempotent webhooks, provider-verified accounting, renewals, refunds, recovery"
proof champions-club test-saas-school-billing-integrity.mjs "HON school billing reads (B5.1) and inactive paid-access foundation: exact-school billing.hon.view, organization billing, stable pagination, verified vs recorded, dry run with enforcement NONE"
proof champions-club test-language-preferences-integrity.mjs "Interface language persistence: self-only personal preference, exact-school audited default, precedence, idempotent race-safe updates"
proof champions-club test-saas-paid-access-integrity.mjs "HON paid access B6A (program INACTIVE; ACTIVE simulated in the disposable DB only): awaiting first payment, server-decided tier and allowance on verified payment, replay/out-of-order/tampering/refund safeguards, HQ review and retry"
proof champions-club test-saas-hon-os-offers-integrity.mjs "HON OS commercial offers (0181): one product, HQ-priced versioned offers, owner-only digest-approved publication, immutable published offers, stop-sales, exact-school discovery, legacy billing untouched"
proof champions-club test-saas-hon-os-purchase-integrity.mjs "HON OS purchase binding (0182): six HQ-published offers bought end to end in TEST MODE through the simulated Stripe adapter at the exact accepted offer, sale limit and founder pool under contention, review paths, renewals, refunds and disputes"
proof champions-club test-saas-hon-os-new-school-onboarding.mjs "HON OS new-school onboarding (0183, D7; paid access ACTIVE simulated in the disposable DB only): private registration awaiting first payment, HON OS purchase without an active entitlement, verified activation for every offer kind, failed/cancelled/expired/out-of-order/replayed payments, HQ retry with sale-limit and founder rechecks"
proof champions-club test-saas-hon-os-only-new-sales.mjs "HON OS-only new sales (0184, D8; legacy sales pinned CLOSED, reopened only to build the pre-closure fixture): every legacy sale path refused for new customers (school/HQ checkout, replayed keys, provider sessions, HQ records and founder holds, direct writes), stale legacy payments held for review, HON OS-only first purchases, legacy customers' renewals, refunds, disputes and lifetime rights unchanged"
proof champions-club test-saas-secure-hq-provisioning.mjs "Secure HQ provisioning (0185, D9): provisioned schools get no access, capability or credits; only a current HQ owner grants a scoped, 90-day-capped, audited, idempotent exception (operators, support, school owners, AI/delegated contexts, forged fields and direct writes refused); revocation, expiry, scheduling and closing; revoke-first pilot conversion (awaiting-first-payment refused while an exception is active or scheduled, then D7 after revocation or expiry); never a purchase basis or widened by a tier change; existing customers, D7 first purchase and D8 closure unchanged"
proof champions-club test-school-owner-invitations-integrity.mjs "P0-1: signed OIDC account invitations, exact-school OWNER binding, single use, expiry, revocation, NOWAIT authority concurrency, immutable private evidence, no commercial effects"
proof champions-club test-school-ownership-handoff.mjs "B-ID-4 school ownership (0223, HQ seats kept, H-4, H-5): guarded disposable target, provisioning keeps the HQ OWNER seat and acceptance leaves it open, no cleanup surface, first owner is primary and HQ can move it, existing owners get invited/added notices, immutable evidence"
proof champions-club test-school-staff-invitations-integrity.mjs "S2 staff provisioning (0204 provisional): signed OIDC staff invitations to one existing custom role at one exact school, issuer authority re-proven at acceptance, no escalation, single use, expiry, revocation, never link by email, immutable private evidence, no commercial effects"
proof champions-club test-hon-os-public-signup-integrity.mjs "B-ID-5 HON OS public sign-up (0241): signed verified-email OIDC session creates one owner identity, organization, school and OWNER grant, REGISTERED with a SUSPENDED entitlement and no access, billing or AI; CLOSED by default (TEST_MODE only in the disposable database); never merge by email; one school per identity under concurrency; immutable registration and terms evidence; 0273: disposable email domains refused, hourly and daily admission limits hold under a race for the last seat; 0274: limits are versioned, the HQ owner alone changes them (idempotent, audited), HQ sees usage and cap hits, a cap hit is counted only while the limit is reached"
proof champions-club test-school-family-access-invitations-integrity.mjs "S2 parent/guardian linking (0205 provisional): signed OIDC invitations to one existing active family at one exact school, issuer authority re-proven at acceptance, staff-ended access, single use, expiry, revocation, never link by email, immutable private evidence, no commercial effects"
proof champions-club test-school-person-record-update-integrity.mjs "B-CRM-1a/1b person record (0217, 0218 proposed): exact-school read and optimistic name/email/phone edit by live people.update human authority with paid access in effect, closed input, audit and contact-free outbox, exact replay, opted-in contacts never moved, authority decided after the last write (revoked or clock-expired grant commits nothing); reasoned birth date correction, a known minor becoming an adult only by a live school OWNER"
proof champions-club test-saas-subscription-generation-integrity.mjs "Commercial B1 0189: immutable A2 generation lineage, zero provider binding, human authorization, race-safe exact retries and inert billing gates"
proof champions-club test-saas-schedule-billing-integrity.mjs "HON OS schedule billing 0230 + 0235: TEST-only deterministic schedule binding, locked-price paid-period evidence, BOUND->ACTIVE billing outcome with isolated access hook, first verified payment -> COMPLETE access for paid period + 7-day grace (program INACTIVE -> HQ review), HQ-owner retry, forward-only renewal extension, audited closed transitions, void/expiry fail-closed, forced RLS and no checkout effect"
proof champions-club test-saas-price-acceptance-integrity.mjs "Commercial A2: immutable schedules/disclosures, signed-session acceptance, authorization/lock races, no billing"
proof champions-club test-saas-trial-governance-integrity.mjs "D11-A: isolated trial policy/campaign metadata, owner-only bounded publication, immutable decisions, concurrency and no activation"
proof champions-club test-saas-exception-policy-integrity.mjs "D10 exception-only approval (0186, read terms + viewer 0222): no policy means no grant; validity, owner authority, immutable binding, atomic evidence, concurrent withdrawal, no credits or payment activation"
proof champions-club test-saas-access-exception-hardening.mjs "Access exception hardening (0185, D9 review corrections): revocations and grants that wait while HQ-owner authority is revoked or expires commit nothing, later authority changes wait without deadlock, same-key retries; closing works through more than 200 open exceptions without closing live ones; Champions contest eligibility and freeze require the entitlement window"
proof champions-club test-hq-access-overview.mjs "HQ access overview (0219, B-HQ-1): only HQ owners and billing operators read every organization's access standing; statuses, open exception, subscription and owner-invitation facts; advisory exception eligibility agrees with the grant command; policy-not-ready shown; paging, order, summary and filter exact; writes nothing, no invitation email"
proof champions-club test-hq-school-detail.mjs "HQ school detail (0225, C-HQ-3): only HQ owners and billing operators read one school; organization row equals the overview row; ownership summary with HQ seats apart; owner/staff/family invitation and people counts scoped to the one school; 404/400; writes nothing; no email, token or name"
proof champions-club test-hq-support-cases.mjs "HQ support records (0232, B-HQ-2): only HQ owners and hq.support.manage holders read or write; runtime has entry points only; idempotent open/note/change with version checks; eligible assignees only; closed is final; immutable ordered history; list filter, paging and summary exact; revoked reader refused"
proof champions-club test-hq-marketing-campaigns.mjs "HQ marketing campaigns (0252, M1): only HQ owners and hq.marketing.manage holders write, hq.marketing.read only reads; runtime has entry points only; idempotent create/update/status with version checks; unique codes; allowed status moves only, archived is final; immutable history; list filter, paging and summary exact; no school campaign rows; revoked person refused"
proof champions-club test-hq-creative-studio.mjs "HQ Creative Studio + HQ creative budget (0253, M2): HQ owner alone sets the monthly HQ cap (versioned, never below use, immutable history) and resolves held requests; hq.marketing.manage requests, hq.marketing.read reads; runtime has entry points only; no provider = refused before any write; reserve against the HQ cap at the published rates with pause/campaign/in-progress/exhaustion refusals; idempotent replay; outcomes recorded once; interrupted after 120 s; no school creative wallet, lot, ledger, reservation or usage row touched; revoked person refused"
proof champions-club test-entitlement-enforcement-coverage.mjs "B6A behavioural entitlement coverage: every runtime-callable function called for ACTIVE vs SUSPENDED organizations; reviewed allowlist, recorded gaps, no cross-organization access"
proof champions-club test-hon-os-trial-runtime-integrity.mjs "D11-B HON OS free trial (0246): a REGISTERED owner starts one HQ-owner-approved public 14-day trial through a signed session; entitlement ACTIVE until exactly start + 14 days and ends by the clock; no charge, payment method, subscription or checkout; agent AI only under the HQ-set campaign credit (per-school, daily, per-request and campaign cost caps, expiry), never Creative Studio media; one trial per organization under concurrency, campaign capacity; 0272: open holds count toward the campaign cost cap, HQ sees trial credits left, lost holds from an earlier month still use trial credits, a replay after the owner grant is revoked is refused; 0273 hourly trial admission limit; CLOSED by default (TEST_MODE only in the disposable database); runs last on this fixture because it adds a newer trial approval"

# CRM adult registration to membership DRAFT (Manus PR #27 lineage, migrations 0159, 0160, 0162, 0163).
setup flexible-billing-accounts HON_FLEXIBLE_BILLING_ACCOUNTS_VALIDATION_TARGET hon_flexible_billing_accounts_validation HON_FLEXIBLE_BILLING_ACCOUNTS_ENV_FILE
proof flexible-billing-accounts test-flexible-billing-account-integrity.mjs "Flexible billing accounts: deterministic canonical backfill, explicit audited additional accounts, direct-human authority"
proof flexible-billing-accounts test-billing-account-crm-draft-compatibility-integrity.mjs "Billing account vs adult CRM DRAFT: both lock arrival orders without deadlock or duplicates; pre-0159 idempotency replay preserved"
proof flexible-billing-accounts test-crm-owner-launch-lock-order-integrity.mjs "Owner Launch / CRM / billing canonical lock order: every workflow paused at every lock stage against every other; pre-0169 deadlocks reproduced, none with 0169"
proof flexible-billing-accounts test-crm-lead-registration-recovery-integrity.mjs "CRM lead registration recovery (0174): read-only session recovery, historical receipt vs current DRAFT, stale/revoked/duplicate/cross-school refusal, zero effects"
proof flexible-billing-accounts test-school-membership-plan-catalog-integrity.mjs "School membership plan catalog (0175): per-school versioned plans, immutable terms, AVAILABLE-only staff options, plan-bound adult DRAFT with exact version binding, no schedule/invoice/payment effect"
proof flexible-billing-accounts test-crm-guardian-child-enrollment-integrity.mjs "CRM guardian/child enrollment (0176): separate guardian/child identities, explicit payer designation through the canonical account, additional children with staff-review ambiguity, one plan-bound DRAFT per child, no schedule/invoice/payment effect; 0218 audited name/birth date corrections carried into the enrollment"
proof flexible-billing-accounts test-membership-activation-gate-integrity.mjs "Membership activation gate (0177): two-step human preview and confirmation, runtime UPDATE revoked and settings-free transition trigger, school-scoped activate/override/cancel authority with live re-checks, identity-review override, school-local inclusive dates across DST, exact idempotency and concurrency, no payment or entitlement effect"
proof flexible-billing-accounts test-crm-lead-membership-discovery-integrity.mjs "CRM lead membership discovery (0200, D-M1): one lead -> the memberships its own adult or guardian/child workflow created, in any lifecycle state; activation + lead-read direct-human authority, school isolation, full-family ordering, zero effects"
proof flexible-billing-accounts test-membership-date-revision-integrity.mjs "Membership date revisions (0178): two-step human date revisions bound to immutable history by the extended settings-free trigger, owner-only retroactive authority with live re-checks, school-local inclusive dates, legacy confirmation queue and exact status totals, no-deadlock races with invoices, cancellation, renewal and retention, no payment or financial effect"
setup crm-lead-registration HON_CRM_LEAD_REGISTRATION_VALIDATION_TARGET hon_crm_registration_validation HON_CRM_LEAD_REGISTRATION_ENV_FILE
proof crm-lead-registration test-crm-lead-registration-integrity.mjs "CRM lead registration: direct-human scope, adult/guardian-child identity separation, idempotency, rollback, no payment or membership effect"

# Owner Launch regression (registration, booking, membership DRAFT and confirmations) over the full
# migration chain, including 0169's re-created confirmation body. Its test loads the generated
# descriptor itself and refuses inherited database URLs, so it is not sourced like the others.
setup owner-launch HON_OWNER_LAUNCH_VALIDATION_TARGET hon_owner_launch_validation HON_OWNER_LAUNCH_ENV_FILE
echo "::group::Owner Launch regression (test-owner-launch-integrity.mjs)"
"${clean_env[@]}" "HON_OWNER_LAUNCH_ENV_FILE=$job_dir/owner-launch.env" bash -c 'cd "$1" && node scripts/test-owner-launch-integrity.mjs' _ "$repo_root/packages/database"
echo "::endgroup::"
passed=$((passed + 1))
summary+=("| Owner Launch regression: registration, booking, membership DRAFT and confirmations unchanged | \`test-owner-launch-integrity.mjs\` | pass |")

# This proof needs an isolated PostgreSQL cluster because the application-wide
# local PostgreSQL service can already contain developer-created roles. It still
# refuses every non-local target and uses a private 0700 runner job directory.
adult_draft_fixture='crm-adult-membership-draft'
adult_draft_dir="$(mktemp -d "$job_dir/$adult_draft_fixture.XXXXXX")"
chmod 700 "$adult_draft_dir"
echo "::group::Provision disposable fixture: $adult_draft_fixture"
"${clean_env[@]}" \
  HON_CRM_ADULT_MEMBERSHIP_DRAFT_VALIDATION_TARGET=postgresql://127.0.0.1:55435/hon_crm_adult_membership_draft_validation \
  HON_CRM_ADULT_MEMBERSHIP_DRAFT_ENV_FILE="$adult_draft_dir/$adult_draft_fixture.env" \
  HON_CRM_ADULT_MEMBERSHIP_DRAFT_PGDATA="$adult_draft_dir/pgdata" \
  node "$scripts/setup-crm-adult-membership-draft-validation.mjs"
echo "::endgroup::"
echo "::group::Adult CRM registration to one membership DRAFT"
# shellcheck disable=SC2016 # positional parameters are expanded by the inner shell on purpose
"${clean_env[@]}" bash -c 'set -a; . "$1"; set +a; cd "$2" && node scripts/test-crm-adult-membership-draft-integrity.mjs' _ "$adult_draft_dir/$adult_draft_fixture.env" "$repo_root/packages/database"
echo "::endgroup::"
passed=$((passed + 1))
summary+=("| Adult CRM registration to one membership DRAFT | \`test-crm-adult-membership-draft-integrity.mjs\` | pass |")
/usr/lib/postgresql/16/bin/pg_ctl -D "$adult_draft_dir/pgdata" -m fast -w stop >/dev/null
rm -f "$adult_draft_dir/$adult_draft_fixture.env"

echo "All $passed disposable-database proofs passed (9 fixtures, all migrations applied)."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Disposable PostgreSQL proofs"
    echo "| Proof | Script | Result |"
    echo "| --- | --- | --- |"
    printf '%s\n' "${summary[@]}"
  } >> "$GITHUB_STEP_SUMMARY"
fi
