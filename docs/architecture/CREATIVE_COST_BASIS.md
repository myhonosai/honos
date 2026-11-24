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
- HQ's own Creative Studio (0253) still records its unconfigured or synthetic runtime's cost without a basis.
- No table, grant or data change. Nothing sends, charges or calls a provider.

Tests:

- `apps/api/test/creative-provider-adapters.test.cjs`: basis on every adapter result, plus outcome rules.
- Check G12 in `packages/database/scripts/test-creative-studio-generations.mjs`: stored references, refusals, backward-compatible input and the expense split.
