import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for curriculum integrity tests.');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } });
const ids = Object.fromEntries(['organization', 'school', 'person', 'student', 'curriculumA', 'curriculumB', 'rankA', 'rankB', 'enrollment', 'testingEvent', 'candidate', 'promotion'].map((key) => [key, randomUUID()]));

await client.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)', [ids.organization, 'Curriculum Test']);
  await client.query('INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, $3, $4)', [ids.school, ids.organization, 'Curriculum Test School', `curr-${ids.school.slice(0, 8)}`]);
  await client.query('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, $4, $5)', [ids.person, ids.organization, ids.school, 'Curriculum', 'Student']);
  await client.query('INSERT INTO hon.student_profiles (id, organization_id, school_id, person_id) VALUES ($1, $2, $3, $4)', [ids.student, ids.organization, ids.school, ids.person]);
  for (const [id, name] of [[ids.curriculumA, 'Curriculum A'], [ids.curriculumB, 'Curriculum B']]) {
    await client.query(`INSERT INTO hon.curricula (id, organization_id, school_id, name, model_code) VALUES ($1, $2, $3, $4, 'LINEAR')`, [id, ids.organization, ids.school, name]);
  }
  await client.query('INSERT INTO hon.curriculum_ranks (id, organization_id, school_id, curriculum_id, name, progression_order) VALUES ($1, $2, $3, $4, $5, 1), ($6, $2, $3, $7, $8, 1)', [ids.rankA, ids.organization, ids.school, ids.curriculumA, 'White', ids.rankB, ids.curriculumB, 'Green']);
  await client.query('INSERT INTO hon.student_curriculum_enrollments (id, organization_id, school_id, student_profile_id, curriculum_id, current_rank_id) VALUES ($1, $2, $3, $4, $5, $6)', [ids.enrollment, ids.organization, ids.school, ids.student, ids.curriculumA, ids.rankA]);
  await client.query(`INSERT INTO hon.testing_events (id, organization_id, school_id, curriculum_id, name, starts_at) VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`, [ids.testingEvent, ids.organization, ids.school, ids.curriculumA, 'Curriculum A Test']);
  await client.query('INSERT INTO hon.testing_candidates (id, organization_id, school_id, testing_event_id, student_curriculum_enrollment_id, target_rank_id) VALUES ($1, $2, $3, $4, $5, $6)', [ids.candidate, ids.organization, ids.school, ids.testingEvent, ids.enrollment, ids.rankA]);
  await client.query('SAVEPOINT mixed_curriculum_candidate');
  try {
    await client.query('INSERT INTO hon.testing_candidates (organization_id, school_id, testing_event_id, student_curriculum_enrollment_id, target_rank_id) VALUES ($1, $2, $3, $4, $5)', [ids.organization, ids.school, ids.testingEvent, ids.enrollment, ids.rankB]);
    throw new Error('Mixed-curriculum testing candidate was accepted.');
  } catch (error) { if (error instanceof Error && error.message.includes('Mixed-curriculum')) throw error; if (error?.code !== '23514') throw error; } finally { await client.query('ROLLBACK TO SAVEPOINT mixed_curriculum_candidate'); }
  await client.query('INSERT INTO hon.promotion_decisions (id, organization_id, school_id, testing_candidate_id, student_curriculum_enrollment_id, prior_rank_id, target_rank_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [ids.promotion, ids.organization, ids.school, ids.candidate, ids.enrollment, ids.rankA, ids.rankA]);
  await client.query('SAVEPOINT promotion_without_instructor');
  try {
    await client.query(`UPDATE hon.promotion_decisions SET status = 'PROMOTED' WHERE id = $1`, [ids.promotion]);
    throw new Error('Promotion was finalized without a named instructor decision.');
  } catch (error) { if (error instanceof Error && error.message.includes('Promotion was finalized')) throw error; if (error?.code !== '23514') throw error; } finally { await client.query('ROLLBACK TO SAVEPOINT promotion_without_instructor'); }
  await client.query('ROLLBACK');
  console.log('Verified curriculum/test/candidate integrity and mandatory human instructor data for final promotion decisions.');
} finally { await client.end(); }
