# HON Local / Mock AI Model Evaluation

## Purpose and boundary

This is a **deterministic, local/mock comparison framework** for deciding whether an AI model candidate has enough evidence to be considered by a human/HQ reviewer. It is deliberately not a provider adapter, benchmark claim, production default selector, routing-policy writer, model assignment endpoint, Action Engine request, work-item executor, credit charge, or customer-visible operation.

`evaluateAiModelCandidates()` is a pure function. It accepts only a complete safe score matrix and returns:

```text
execution: LOCAL_OR_MOCK_ONLY
productionAssignment: NOT_PERFORMED
```

It performs no I/O, provider call, model invocation, tool call, arbitrary HTTP, database write, Action Engine operation, routing-policy mutation, or subscription/credit change.

## Reusable fixture manifest

`@hon/config` provides `AI_MODEL_EVALUATION_FIXTURE_MANIFEST`, containing safe IDs/categories/check labels only—not prompts, private school data, raw outputs, provider credentials, tenant identifiers, routes, or tools.

| Category | Safe fixture | Required checks |
|---|---|---|
| General AI Assistant | `general-operations-boundary` | usefulness, instruction following, permission compliance, escalation, consistency |
| Marcus — Marketing | `marcus-campaign-draft` | marketing effectiveness, structured output, hallucination risk, consistency |
| Chad — Sales | `chad-follow-up-draft` | sales communication, permission compliance, escalation, consistency |
| Claire — Teaching | `claire-lesson-plan` | teaching accuracy, structured output, hallucination risk, instruction following, consistency |
| Retention | `retention-evidence-summary` | evidence boundary, hallucination risk, permission compliance, escalation, consistency |
| School Command Center | `command-center-explanation` | performance explanation, usefulness, structured output, consistency |
| AI Workflow Planning | `workflow-plan-boundary` | tool-calling/structured output, permission compliance, escalation, instruction following, consistency |
| Simple Classification | `classification-schema` | structured output, speed, cost efficiency, consistency |

Local fixture content and judge evidence remain outside product source control unless independently reviewed and approved for inclusion. Every candidate compared in a run must be evaluated once and only once against the **entire exact approved manifest**; a partial, duplicated, renamed, category-mismatched, or caller-invented fixture set is rejected. The manifest, its entries, and check arrays are deeply frozen at runtime.

## Scorecard

The evaluator has the approved fixed weighting:

| Dimension | Weight | Evidence |
|---|---:|---|
| Answer quality and usefulness | 35% | Local/mock judge `answerQualityScore` (0–100) |
| Reliability and instruction following | 25% | Instruction score plus compliance, hallucination-safety, escalation and repeated-consistency gates |
| Tool calling and structured outputs | 20% | Valid structured-output gate per fixture; never a tool grant |
| Response speed | 10% | Relative average latency across the identical fixture set |
| Cost efficiency | 10% | Relative average estimated micro-cost across the identical fixture set |

A candidate is eligible for **owner review only** when every fixture records valid structured output, permission compliance, no observed hallucination, appropriate escalation, and repeated consistency. A failed gate remains visible and sorts below gated candidates even if quality is higher. A comparison leader is not a production selection.

## Candidate identities and live verification

The evaluator accepts only a short opaque local `candidateId` and code-owned provider ID; it intentionally does **not** accept, persist, or return a caller-supplied raw model ID. The approved candidate-to-concrete-model matrix stays in [Blueprint 2.2 integration](BLUEPRINT_UPDATE_2_2_INTEGRATION_MAP.md), outside the local report payload. Its concrete IDs are **evaluation candidates only**. Before any HQ catalog/policy/default change:

1. Re-read live provider catalog metadata and verify the exact concrete ID, availability, capability/modalities, endpoint behavior, privacy terms, and current prices.
2. Preserve the existing validated routing policy until the candidate has passed relevant local/mock fixtures.
3. Obtain explicit owner authorization for any bounded external/provider validation. No previous paid-test approval carries forward.
4. Revalidate the candidate through the existing HQ control plane; the router remains selection-only and server-controlled.
5. Record requested/actual model, provider endpoint, task category, tokens, actual cost, latency, fallback/retry/error and related work/Action evidence in the existing AI usage/economics path. Do not change pricing or credit allowances merely because the candidate ranked first.

## Safety invariants

- Essential, Core, and Complete remain product tiers, not model-intelligence proxies. Each retains the existing useful general-AI surface and allowance; this framework changes neither pricing nor credits.
- Candidate metadata and reportable IDs use narrow safe grammars and cannot carry a credential, secret reference, API/private key marker, auth marker, URL, prompt, output, tenant, permission, tool, Action Engine authority, routing policy, or provider endpoint. The code-owned provider IDs, fixed score weights, report, rankings, candidate/scores, failed-ID arrays, evaluated-fixture IDs, and each report's weight snapshot are frozen so consumer mutation cannot affect later evaluations or a reported result.
- Model selection never grants tenant access, role permission, tool access, execution, financial, communication, or approval authority. Consequential work remains **AI → typed HON tool → policy/permission/authority/approval → normal domain service → verification/audit**.
- Provider/model availability remains separate from conventional HON availability. An unavailable candidate does not degrade normal software.
- The framework deliberately does not infer a provider price/capability from an old catalog or public benchmark.

## Validation

```bash
pnpm test:ai-model-evaluation
```

The tests prove exact frozen 35/25/20/10/10 weights, frozen code-owned providers and manifest, deep immutable report snapshots, stable ordering, mandatory full manifest matching, immutable/no-network evaluation, strict complete-matrix validation, independent unsafe-output/permission/hallucination/escalation/consistency gate precedence, and rejection of unsafe identifier/provider/authority/route/credential fields.
