# HQ AI costs per specialist (migration 0328)

Alex (0260), Jordan (0260), Lena (0260) and Maya (0284) answer through HON's reply table, as Claire does (0229). Before
this change, the HQ per-school usage read (`hon.read_ai_school_usage_from_hq`, last body 0272) counted their calls under
`HON_REPLY`, because 0267 moved only Claire.

## Change

- New code-owned helper `hon.ai_usage_reply_agent(specialist)` maps each specialist to the agent name that AI team
  readiness already uses:

  | Specialist | Agent |
  |---|---|
  | claire | `BUSINESS_PERFORMANCE` |
  | alex | `GENERAL_MANAGEMENT` |
  | jordan | `OPERATIONS` |
  | lena | `CREATIVE_COMMERCE` |
  | maya | `RETENTION` |
  | hon, or any unknown value | `HON_REPLY` |

- Late provider expenses recorded as `HON_REPLY` move by the same rule.
- Contracts `AI_USAGE_AGENTS` adds the four names. The HQ AI costs page labels them (en, ko and es).

## Unchanged

- Class totals, school totals, write-offs and unresolved counts.
- The S4 enumerations (UNKNOWN resolution and the late expense agent stay `HON_REPLY` for reply rows).
- ACLs: the read keeps its grant and the helper is migration-owner only.

## Tests

- AI-0 INV-36: Alex, Jordan and Lena count under their own agents, and `HON_REPLY` counts only HON's own rows.
- AI-0 INV-37: Maya counts under `RETENTION`, and the helper is not reachable by the runtime.
- The contracts test accepts the four new agents.
