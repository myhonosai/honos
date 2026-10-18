#!/usr/bin/env bash
# Runs a focused set of HON PostgreSQL security/integrity proofs against a DISPOSABLE local
# PostgreSQL on localhost:5432. It reuses the repository's own guarded setup scripts unchanged:
# each one creates a marked, dedicated database and least-privilege owner/runtime roles, applies
# every migration, and writes generated credentials to a private mode-0600 file.
#
# Safety:
# - Runs only on an ephemeral GitHub-hosted runner, or locally with HON_DB_PROOFS_LOCAL=1.
# - Never reads or accepts a DATABASE_URL; the setup scripts refuse anything but localhost:5432.
# - Every setup/proof runs under `env -i` with only PATH/HOME/LANG, so no token, provider key,
#   or CI credential is visible to it (the scripts also refuse such variables themselves).
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  [[ "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]] || { echo "Refusing: database proofs run only on ephemeral GitHub-hosted runners." >&2; exit 1; }
elif [[ "${HON_DB_PROOFS_LOCAL:-}" != "1" ]]; then
  echo "Refusing: set HON_DB_PROOFS_LOCAL=1 to run against your own disposable localhost:5432 PostgreSQL." >&2
  exit 1
fi
if [[ -n "${DATABASE_URL:-}" || -n "${HON_RUNTIME_DATABASE_URL:-}" ]]; then
  echo "Refusing: unset DATABASE_URL/HON_RUNTIME_DATABASE_URL; fixtures generate their own disposable credentials." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="$repo_root/packages/database/scripts"
# The setup scripts only write credentials beneath this private job root.
job_dir="/home/ubuntu/jobs/ci_db_proofs"
if [[ ! -d "$job_dir" ]]; then
  sudo mkdir -p "$job_dir"
  sudo chown "$(id -u):$(id -g)" /home/ubuntu /home/ubuntu/jobs "$job_dir"
fi
chmod 700 "$job_dir"
rm -f "$job_dir"/*.env
# Remove generated disposable credentials on every exit path, including failures.
# The enrollment preparation fixture owns a nested private cluster, so clean its
# mode-0600 environment file and stop its process even when its proof fails.
preparation_dir=''
cleanup() {
  rm -f "$job_dir"/*.env "$job_dir"/*/*.env
  if [[ -n "$preparation_dir" && -d "$preparation_dir/pgdata" ]]; then
    /usr/lib/postgresql/16/bin/pg_ctl -D "$preparation_dir/pgdata" -m fast -w stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

clean_env=(env -i "PATH=$PATH" "HOME=$HOME" "LANG=C.UTF-8")
passed=0
summary=()

setup() { # name, target-variable, database, env-file-variable
  local name="$1" target_var="$2" database="$3" file_var="$4"
  echo "::group::Provision disposable fixture: $name"
  "${clean_env[@]}" "$target_var=postgresql://localhost:5432/$database" "$file_var=$job_dir/$name.env" \
    node "$scripts/setup-$name-validation.mjs"
  echo "::endgroup::"
}

proof() { # fixture, script, description
  local fixture="$1" script="$2" description="$3"
  echo "::group::$description ($script)"
  # shellcheck disable=SC2016 # positional parameters are expanded by the inner shell on purpose
  "${clean_env[@]}" bash -c 'set -a; . "$1"; set +a; cd "$2" && node "scripts/$3"' _ "$job_dir/$fixture.env" "$repo_root/packages/database" "$script"
  echo "::endgroup::"
  passed=$((passed + 1))
  summary+=("| $description | \`$script\` | pass |")
}

setup class-sessions-read HON_CLASS_SESSIONS_READ_VALIDATION_TARGET hon_class_sessions_read_validation HON_CLASS_SESSIONS_READ_ENV_FILE
proof class-sessions-read test-security-boundaries.mjs "Tenant isolation, restricted runtime role, parent-family boundaries"
proof class-sessions-read test-outbox-leases.mjs "Outbox leases never treat UNKNOWN as published"
proof class-sessions-read test-class-sessions-read-integrity.mjs "Class Sessions current-school read boundary"

setup crm-lead-close HON_CRM_LEAD_CLOSE_VALIDATION_TARGET hon_crm_close_validation HON_CRM_LEAD_CLOSE_ENV_FILE
proof crm-lead-close verify-rls.mjs "Forced RLS on every tracked operational table"
proof crm-lead-close test-crm-lead-close-integrity.mjs "CRM lead close authority, atomicity and replay"

setup champions-club HON_CHAMPIONS_VALIDATION_TARGET hon_champions_validation HON_CHAMPIONS_ENV_FILE
proof champions-club test-champions-club-integrity.mjs "Champions Club authority, attribution, qualification gates and evidence"
proof champions-club test-champions-club-rewards-integrity.mjs "Champions Club reward accounting: liabilities, approvals, reversals, no billing effect"
proof champions-club test-champions-club-leaderboard-integrity.mjs "Champions Club leaderboards: qualified-only standings, privacy, holds, statistics"

# This proof needs an isolated PostgreSQL cluster because the application-wide
# local PostgreSQL service can already contain developer-created roles. It still
# refuses every non-local target and uses a private 0700 runner job directory.
preparation_fixture="curriculum-enrollment-preparation"
preparation_dir="$job_dir/$preparation_fixture"
rm -rf "$preparation_dir"
mkdir -p "$preparation_dir"
chmod 700 "$preparation_dir"
echo "::group::Provision disposable fixture: $preparation_fixture"
"${clean_env[@]}" \
  HON_CURRICULUM_ENROLLMENT_PREPARATION_VALIDATION_TARGET=postgresql://127.0.0.1:55434/hon_curriculum_enrollment_preparation_validation \
  HON_CURRICULUM_ENROLLMENT_PREPARATION_ENV_FILE="$preparation_dir/$preparation_fixture.env" \
  HON_CURRICULUM_ENROLLMENT_PREPARATION_PGDATA="$preparation_dir/pgdata" \
  node "$scripts/setup-curriculum-enrollment-preparation-validation.mjs"
echo "::endgroup::"
echo "::group::Curriculum enrollment preparation direct-human read boundary"
"${clean_env[@]}" bash -c 'set -a; . "$1"; set +a; cd "$2" && node scripts/test-curriculum-enrollment-preparation-integrity.mjs' _ "$preparation_dir/$preparation_fixture.env" "$repo_root/packages/database"
echo "::endgroup::"
passed=$((passed + 1))
summary+=("| Curriculum enrollment preparation direct-human read boundary | \`test-curriculum-enrollment-preparation-integrity.mjs\` | pass |")
/usr/lib/postgresql/16/bin/pg_ctl -D "$preparation_dir/pgdata" -m fast -w stop >/dev/null
rm -f "$preparation_dir/$preparation_fixture.env"

echo "All $passed disposable-database proofs passed (4 fixtures, all migrations applied)."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Disposable PostgreSQL proofs"
    echo "| Proof | Script | Result |"
    echo "| --- | --- | --- |"
    printf '%s\n' "${summary[@]}"
  } >> "$GITHUB_STEP_SUMMARY"
fi
