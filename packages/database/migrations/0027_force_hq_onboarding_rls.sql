BEGIN;

-- HQ onboarding requests contain privileged operator workflow state and must
-- not inherit owner bypass behavior through a table owner or definer function.
ALTER TABLE hon.hq_onboarding_requests FORCE ROW LEVEL SECURITY;

COMMIT;
