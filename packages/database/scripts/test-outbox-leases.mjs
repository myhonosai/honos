import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for outbox lease tests.');
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});
const organizationId = randomUUID();
const schoolId = randomUUID();
const eventOneId = randomUUID();
const eventTwoId = randomUUID();

await client.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)', [organizationId, 'Outbox Lease Test']);
  await client.query('INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, $3, $4)', [schoolId, organizationId, 'Outbox Lease Test School', `outbox-${schoolId.slice(0, 8)}`]);
  for (const [eventId, occurredAt] of [[eventOneId, '2000-01-01T00:00:00Z'], [eventTwoId, '2000-01-01T00:00:01Z']]) {
    await client.query(`INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, payload, occurred_at)
      VALUES ($1, $2, $3, 'test.outbox.lease', 1, 'TEST', $4, 1, $5, '{}'::jsonb, $6::timestamptz)`, [eventId, organizationId, schoolId, randomUUID(), randomUUID(), occurredAt]);
  }
  await client.query('COMMIT');

  const claimOne = await client.query('SELECT * FROM hon.claim_outbox_delivery_batch($1, $2) WHERE event_id = $3::uuid', [1, 15, eventOneId]);
  const first = claimOne.rows[0];
  if (!first?.lease_token) throw new Error('Failed to claim the first outbox event.');
  await client.query('UPDATE hon.outbox_events SET lease_expires_at = now() - interval \'1 second\' WHERE id = $1', [eventOneId]);
  const late = await client.query(`SELECT status::text, accepted FROM hon.record_outbox_delivery_result_v2($1::uuid, $2::uuid, 'PUBLISHED'::hon.outbox_delivery_outcome, NULL, 60)`, [eventOneId, first.lease_token]);
  if (late.rows[0]?.status !== 'DEAD_LETTER' || late.rows[0]?.accepted !== false) throw new Error('Late outbox delivery completion was not retained as an unknown/dead-letter state.');

  const claimTwo = await client.query('SELECT * FROM hon.claim_outbox_delivery_batch($1, $2) WHERE event_id = $3::uuid', [1, 15, eventTwoId]);
  const second = claimTwo.rows[0];
  if (!second?.lease_token) throw new Error('Failed to claim the second outbox event.');
  await client.query('UPDATE hon.outbox_events SET lease_expires_at = now() - interval \'1 second\' WHERE id = $1', [eventTwoId]);
  const reconciled = await client.query('SELECT hon.reconcile_expired_outbox_leases($1) AS count', [10]);
  if (Number(reconciled.rows[0]?.count) < 1) throw new Error('Expired outbox lease was not reconciled.');
  const result = await client.query(`SELECT event.status::text, attempt.outcome::text FROM hon.outbox_events event
    JOIN hon.outbox_delivery_attempts attempt ON attempt.outbox_event_id = event.id
    WHERE event.id = $1::uuid`, [eventTwoId]);
  if (result.rows[0]?.status !== 'DEAD_LETTER' || result.rows[0]?.outcome !== 'UNKNOWN') throw new Error('Expired outbox lease did not preserve UNKNOWN delivery evidence.');
  console.log('Verified expired and late outbox leases become UNKNOWN/DEAD_LETTER rather than PUBLISHED or automatic retry.');
} finally {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM hon.outbox_delivery_attempts WHERE outbox_event_id IN ($1, $2)', [eventOneId, eventTwoId]);
    await client.query('DELETE FROM hon.outbox_events WHERE id IN ($1, $2)', [eventOneId, eventTwoId]);
    await client.query('DELETE FROM hon.schools WHERE id = $1', [schoolId]);
    await client.query('DELETE FROM hon.organizations WHERE id = $1', [organizationId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  await client.end();
}
