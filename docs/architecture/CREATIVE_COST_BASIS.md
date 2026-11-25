# Creative cost basis (0637, launch-readiness review [22])

The Higgsfield and HeyGen adapters, and the synthetic runtimes, compute a generation's cost from HON's own per-unit rate
(`HIGGSFIELD_API.costMicrosPerUnit`, `HEYGEN_API.costMicrosPerSecond`). The creative wallet used to record that number as
if it were the provider's actual cost. Real downloads are refused today because media storage is unavailable, so no
deployed expense was fabricated. This change fixes the meaning before those paths are extended.

## Rule

Every recorded creative cost carries a basis:

| Basis | Meaning | Stored `cost_reference` |
|---|---|---|
| `HON_ESTIMATE` | HON's rate times the units. An upper-bound estimate, not an invoice. | `hon:cost-basis:estimate` |
| `PROVIDER_REPORTED` | The provider's own answer stated the cost. | `hon:cost-basis:provider-reported` |
| HQ evidence | HQ recorded a late cost with an evidence reference (existing 0202 path). | that evidence reference |
| none (before 0637) | Recorded before the basis existed. No adapter ever reported a provider cost, so it counts as an estimate. | `NULL` |

- `CreativeResult.providerCostBasis` is required. Every adapter returns `HON_ESTIMATE` today. A result with a missing or unknown basis fails verification and is held `UNKNOWN`.
- `CreativeOutcome.providerCostBasis` is present exactly when a cost is. A thrown `FAILED` with a cost defaults to `HON_ESTIMATE`.
- `hon.creative_record_generation_result` and `hon.settle_saas_creative_credits` accept the optional key. A cost without a valid basis, or a basis without a cost, is refused (`INVALID_SAAS_INPUT`). Inputs without the key are accepted unchanged, so the API and database can deploy in either order.
- `hon.saas_creative_expense_json` adds `estimatedProviderCostMicrounits`: the part of the recorded provider cost that is only HON's estimate. The contract accepts it when present, and it must not exceed the recorded total.
- The HQ creative credits page shows "Of which HON estimate (not a provider invoice)" under the recorded provider cost.

## Unchanged

- Credits, caps, holds and the usage ledger are unchanged. An upper-bound estimate stays the conservative spend figure for caps.
- No table, grant or data change. Nothing sends, charges or calls a provider.

Tests:

- `apps/api/test/creative-provider-adapters.test.cjs`: basis on every adapter result, plus outcome rules.
- Check G12 in `packages/database/scripts/test-creative-studio-generations.mjs`: stored references, refusals, backward-compatible input and the expense split.

## HQ Creative Studio (0651)

HQ's own Creative Studio (0253) records the same adapters' cost in `hon.hq_creative_generations`. 0651 gives it the same basis:

- The HQ service reuses `verifiedOutcome` and `thrownOutcome`, so every HQ result carries `providerCostBasis` exactly when it carries a cost.
- `hon.record_hq_creative_generation_result` accepts the optional key with the same rules (a cost without a valid basis, or a basis without a cost, is `INVALID_SAAS_INPUT`) and stores it in the new column `provider_cost_basis`. Inputs without the key are accepted unchanged.
- `provider_cost_basis` is set only with a `RECORDED` cost and moves only at completion (`guard_hq_creative_record`). `NULL` means no basis was stated: a NOT_SENT known zero, an owner resolution, or a row recorded before 0651. It is never read as a provider-reported cost.
- Deploy order: apply 0651 before `hon-api`. The new API always sends the key, which 0253 alone refuses.
- No HQ screen shows this cost today; the owner resolution path is unchanged.

Test: section 5b of `packages/database/scripts/test-hq-creative-studio.mjs` (stored basis, legacy input, refusals, API path, immutability, the cost constraint) and `apps/api/test/hq-creative.test.cjs` (the basis on every outcome the HQ service records).
