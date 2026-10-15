BEGIN;

-- Audit evidence and outbox events are immutable after insertion from the
-- normal application runtime. Dispatcher/state-management work will use a
-- separately reviewed worker capability, never the tenant request role.
DROP POLICY audit_events_tenant_isolation ON hon.audit_events;
CREATE POLICY audit_events_scoped_read ON hon.audit_events
  FOR SELECT
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY audit_events_scoped_append ON hon.audit_events
  FOR INSERT
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

DROP POLICY outbox_events_tenant_isolation ON hon.outbox_events;
CREATE POLICY outbox_events_scoped_read ON hon.outbox_events
  FOR SELECT
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY outbox_events_scoped_append ON hon.outbox_events
  FOR INSERT
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

COMMIT;
