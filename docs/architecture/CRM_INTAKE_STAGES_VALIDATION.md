# CRM Intake-Stage Read: Disposable PostgreSQL Validation

## Status

**Passed on localhost** against a freshly created, marked disposable database after applying migrations through `0151_current_school_crm_intake_stages_read.sql` and building `@hon/contracts`, `@hon/database`, and `@hon/api`.

The fixture is intentionally constrained to:

- database: `hon_crm_intake_stages_validation`
- migration owner: `hon_crm_intake_stages_owner`
- runtime role: `hon_crm_intake_stages_runtime`
- target: `postgresql://localhost:5432/hon_crm_intake_stages_validation`

Its setup refuses inherited `DATABASE_URL` and `HON_RUNTIME_DATABASE_URL`, provider/credential and execution-switch environment variables, non-local targets, unmarked existing database/roles, unsafe credential-file paths, and non-private job directories. Credentials are generated only into a fresh mode-0600 file under a mode-0700 `/home/ubuntu/jobs/...` directory.

## Commands

```bash
# Use a fresh, private job directory. The setup accepts no inherited DB URLs.
mkdir -p /home/ubuntu/jobs/<private-job>
chmod 700 /home/ubuntu/jobs/<private-job>

env -i PATH="$PATH" HOME=/home/ubuntu LANG=C.UTF-8 \
  HON_CRM_INTAKE_STAGES_VALIDATION_TARGET=postgresql://localhost:5432/hon_crm_intake_stages_validation \
  HON_CRM_INTAKE_STAGES_ENV_FILE=/home/ubuntu/jobs/<private-job>/crm-intake-stages.env \
  pnpm db:setup-crm-intake-stages

# The generated private file supplies only the two exact localhost aliases.
env -i PATH="$PATH" HOME=/home/ubuntu LANG=C.UTF-8 bash -c '
  set -a; . /home/ubuntu/jobs/<private-job>/crm-intake-stages.env; set +a
  pnpm db:test-crm-intake-stages
'
```

The database is isolated by fixed marker ownership and is recreated only when the existing database and both roles have the expected marker. It never selects a remote database.

## Assertions proven

| Boundary | Fixture assertion |
|---|---|
| Projection | Returns exactly the first **25** lexicographic pipeline/stage choices; only current-school, non-terminal choices appear. |
| Contract | Every returned object has exactly `pipelineId`, `pipelineName`, `stageId`, and `stageName`; terminal, cross-school, and out-of-cap facts are absent. |
| Read-only | The built `CrmIntakeStagesService` runs successfully without changing table counts; permitted and denied reads have no write effect. |
| Runtime isolation | Runtime table `SELECT` and helper-function execution are denied; the fixed function is executable only through the bounded, authorized path and rejects an unscoped direct call. |
| Live authority | A current active direct human with exact `crm.lead.create`, `is_staff_assignable`, and a live active entitlement is required. |
| Rejections | HQ, family, parent/mixed-role, duplicate-principal, nonhuman, automated/integration source, action request, delegation, mismatched school, principal, and subject contexts are denied through both service and direct SQL paths where applicable. |
| Drift | Forced RLS on both source tables, runtime grants, helper grants, public execution, and fingerprints of both security-definer functions are verified; transactional drift attempts are rejected. |

The database package commands are `db:setup-crm-intake-stages` and `db:test-crm-intake-stages`; matching root forwarding commands are also registered.
