BEGIN;

-- Recovery migration for databases that applied 0027 before its ENABLE clause.
ALTER TABLE hon.hq_onboarding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_onboarding_requests FORCE ROW LEVEL SECURITY;

COMMIT;
