// Issue #100 / 0201: READ-ONLY operator checks for HON SaaS billing periods written before 0201 by a non-UTC
// session. Each query lists stored periods that differ from the approved UTC recomputation (the ORIGINAL anchor plus
// whole UTC calendar months, clamped to the end of a shorter month, anchor time of day kept). They only read; they
// never correct anything. Historical financial records are not changed automatically: every row found is reported
// to the owner for a decision (docs/architecture/SAAS_BILLING_UTC_PERIODS_OPERATOR_CHECK.md).
// Used by the proofs, so the exact text an operator runs is the text that is tested.

const months = "CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END";
const utcAt = index => `((s.period_anchor_at AT TIME ZONE 'UTC')+make_interval(months=>(${index})*${months})) AT TIME ZONE 'UTC'`;

/** Current period of each monthly or annual subscription. */
export const DIVERGENT_PERIODS_SQL = `SELECT s.id,s.organization_id,s.billing_interval,s.period_index,s.current_period_start,s.current_period_end,
  ${utcAt('s.period_index')} AS utc_period_start,
  ${utcAt('s.period_index+1')} AS utc_period_end
 FROM hon.saas_subscriptions s
 WHERE s.billing_interval IN ('MONTHLY','ANNUAL') AND s.period_index IS NOT NULL AND s.period_anchor_at IS NOT NULL
  AND (s.current_period_start,s.current_period_end) IS DISTINCT FROM (${utcAt('s.period_index')},${utcAt('s.period_index+1')})
 ORDER BY s.id`;

/** Immutable subscription history rows that recorded a period. */
export const DIVERGENT_HISTORY_SQL = `SELECT h.subscription_id,h.version,h.period_index,h.current_period_start,h.current_period_end,
  ${utcAt('h.period_index')} AS utc_period_start,
  ${utcAt('h.period_index+1')} AS utc_period_end
 FROM hon.saas_subscription_history h JOIN hon.saas_subscriptions s ON s.id=h.subscription_id
 WHERE s.billing_interval IN ('MONTHLY','ANNUAL') AND h.period_index IS NOT NULL AND s.period_anchor_at IS NOT NULL
  AND (h.current_period_start,h.current_period_end) IS DISTINCT FROM (${utcAt('h.period_index')},${utcAt('h.period_index+1')})
 ORDER BY h.subscription_id,h.version`;

/** Subscription-period invoices (B2 drafts and provider-paid invoices) and their service period. */
export const DIVERGENT_INVOICES_SQL = `SELECT i.id,i.subscription_id,i.status,i.period_index,i.service_period_start,i.service_period_end,
  ${utcAt('i.period_index')} AS utc_period_start,
  ${utcAt('i.period_index+1')} AS utc_period_end
 FROM hon.saas_invoices i JOIN hon.saas_subscriptions s ON s.id=i.subscription_id
 WHERE i.kind='SUBSCRIPTION_PERIOD' AND s.billing_interval IN ('MONTHLY','ANNUAL') AND s.period_anchor_at IS NOT NULL
  AND (i.service_period_start,i.service_period_end) IS DISTINCT FROM (${utcAt('i.period_index')},${utcAt('i.period_index+1')})
 ORDER BY i.subscription_id,i.period_index,i.id`;

export const UTC_OPERATOR_CHECKS = { subscriptions: DIVERGENT_PERIODS_SQL, history: DIVERGENT_HISTORY_SQL, invoices: DIVERGENT_INVOICES_SQL };

/** Runs every check in one READ ONLY transaction and returns the rows found per check. */
export async function runUtcOperatorChecks(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const out = {};
    for (const [name, sql] of Object.entries(UTC_OPERATOR_CHECKS)) out[name] = (await client.query(sql)).rows;
    await client.query('COMMIT');
    return out;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
