// Test-only UTC expectations for the existing 0154/0156 calendar-month arithmetic.
// Never import this fixture into runtime billing or change the system clock to run it.
import assert from 'node:assert/strict';

export function addUtcMonthsClamped(instant, months) {
  assert.match(instant, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'fixture anchor must be explicit UTC');
  assert.ok(Number.isInteger(months), 'fixture month offset must be an integer');
  const result = new Date(instant);
  assert.ok(Number.isFinite(result.getTime()), 'fixture anchor must be a valid date');
  const day = result.getUTCDate();
  // Move from day 1 so native Date overflow cannot skip the target month.
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const next = new Date(result);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(0);
  result.setUTCDate(Math.min(day, next.getUTCDate()));
  return result.toISOString();
}

// Explicit expected values are independent of Date.now() and of the helper under test.
// Offsets always apply to the ORIGINAL anchor, never an already-clamped period end.
export const UTC_MONTH_CASES = Object.freeze([
  ['2023-01-31T00:00:00.123Z', 1, '2023-02-28T00:00:00.123Z'],
  ['2024-01-31T00:00:00.123Z', 1, '2024-02-29T00:00:00.123Z'],
  ['2023-01-31T00:00:00.123Z', 2, '2023-03-31T00:00:00.123Z'],
  ['2024-01-31T00:00:00.123Z', 2, '2024-03-31T00:00:00.123Z'],
  ['2026-04-30T12:34:56.789Z', 1, '2026-05-30T12:34:56.789Z'],
  ['2026-10-31T06:27:30.754Z', 1, '2026-11-30T06:27:30.754Z'],
  ['2026-10-31T06:27:30.754Z', 2, '2026-12-31T06:27:30.754Z'],
  ['2026-10-31T23:59:59.999Z', 1, '2026-11-30T23:59:59.999Z'],
  ['2026-11-01T00:00:00.000Z', 1, '2026-12-01T00:00:00.000Z'],
  ['2023-01-31T23:59:59.999Z', 1, '2023-02-28T23:59:59.999Z'],
  ['2023-02-01T00:00:00.000Z', 1, '2023-03-01T00:00:00.000Z'],
  ['2026-12-31T23:59:59.999Z', 1, '2027-01-31T23:59:59.999Z'],
  ['2024-02-29T16:45:12.345Z', 12, '2025-02-28T16:45:12.345Z'],
  ['2026-03-31T03:04:05.006Z', -1, '2026-02-28T03:04:05.006Z'],
  ['2026-04-30T00:00:00.000Z', 0, '2026-04-30T00:00:00.000Z'],
  ['2026-01-30T08:09:10.011Z', 1, '2026-02-28T08:09:10.011Z'],
  ['2023-12-31T08:09:10.011Z', 2, '2024-02-29T08:09:10.011Z'],
  ['2026-04-15T08:09:10.011Z', 1, '2026-05-15T08:09:10.011Z'],
].map(Object.freeze));

// Called only AFTER each existing proof has verified its exact disposable database marker.
// SELECT-only comparisons: both sides receive the SAME controlled UTC anchor/offset.
export async function verifyUtcMonthFixtures(client, label, { allowancePeriods = false } = {}) {
  let periods = 0;
  for (const [anchor, months, expected] of UTC_MONTH_CASES) {
    const context = `${label}: ${anchor} + ${months} UTC calendar month(s)`;
    assert.equal(addUtcMonthsClamped(anchor, months), expected, `${context} (JavaScript)`);
    const { rows: [sql] } = await client.query(`SELECT to_char(
      ($1::timestamptz AT TIME ZONE 'UTC') + make_interval(months => $2::integer),
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends_at`, [anchor, months]);
    assert.equal(sql.ends_at, expected, `${context} (PostgreSQL)`);
    if (allowancePeriods && months > 0) {
      // Exercise the actual unchanged 0156 function as well as native SQL arithmetic.
      // Construct a composite VALUE, not a subscription row or an allowance grant.
      const { rows: [period] } = await client.query(`SELECT period_index,
        hon.saas_ts(period_start) AS starts_at, hon.saas_ts(period_end) AS ends_at
        FROM hon.saas_allowance_period(jsonb_populate_record(NULL::hon.saas_subscriptions,
          jsonb_build_object('service_started_at', $1::text, 'billing_interval', 'LIFETIME')),
          (($1::timestamptz AT TIME ZONE 'UTC') + make_interval(months => $2::integer - 1)) AT TIME ZONE 'UTC')`, [anchor, months]);
      assert.deepEqual(period, {
        period_index: months - 1, starts_at: addUtcMonthsClamped(anchor, months - 1), ends_at: expected,
      }, `${context} (actual allowance-period function)`);
      periods++;
    }
  }
  console.log(`PASS ${label}: ${UTC_MONTH_CASES.length} fixed UTC month fixtures (JavaScript + PostgreSQL); ${periods} actual allowance-period cases; no fixture writes`);
}
