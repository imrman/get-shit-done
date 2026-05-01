#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH="main"
DRY_RUN=0
SKIP_INSTALL=0
LOCK_FILE=""
LOG_DIR=""
ORIGIN_REMOTE="origin"
REPO_DIR="$(pwd)"
UPSTREAM_REF="main"
UPSTREAM_URL="https://github.com/gsd-build/get-shit-done.git"
WORK_ROOT=""

PRESERVE_PATHS_DEFAULT=(
  ".github/CODEOWNERS"
  ".github/dependabot.yml"
  ".github/scripts"
  ".github/workflows"
  "SECURITY.md"
  "hooks/gsd-check-update.js"
  "hooks/gsd-check-update-worker.js"
  "hooks/gsd-prompt-guard.js"
  "hooks/gsd-read-guard.js"
  "hooks/gsd-read-injection-scanner.js"
  "hooks/gsd-validate-commit.sh"
  "hooks/gsd-workflow-guard.js"
  "scripts/base64-scan.sh"
  "scripts/prompt-injection-scan.sh"
  "scripts/secret-scan.sh"
)

usage() {
  cat <<EOF
Usage: scripts/unattended-upstream-sync.sh [options]

Fetch origin/main and upstream/main into a temporary worktree, merge upstream,
preserve local hardened security/automation files, validate, promote main, push,
and reinstall GSD into the global Codex config from the validated source.

Options:
  --repo <path>           Repository checkout to coordinate from (default: cwd)
  --upstream-url <url>    Upstream repository URL (default: ${UPSTREAM_URL})
  --upstream-ref <ref>    Upstream ref to merge (default: ${UPSTREAM_REF})
  --base-branch <branch>  Local/origin branch to update (default: ${BASE_BRANCH})
  --origin <remote>       Origin remote name (default: ${ORIGIN_REMOTE})
  --work-root <path>      Parent directory for temporary worktrees
  --lock-file <path>      Lock directory path
  --log-dir <path>        Directory for run logs
  --dry-run               Validate only; skip promotion, push, and install
  --skip-install          Promote and push after validation, but do not install into CODEX_HOME
  -h, --help              Show this help

Environment:
  GSD_SYNC_PRESERVE_PATHS Newline-separated paths to preserve from origin/main
  GSD_SYNC_MIN_SKILLS     Minimum expected gsd-* Codex skills after install (default: 50)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO_DIR="${2:?missing --repo value}"
      shift 2
      ;;
    --upstream-url)
      UPSTREAM_URL="${2:?missing --upstream-url value}"
      shift 2
      ;;
    --upstream-ref)
      UPSTREAM_REF="${2:?missing --upstream-ref value}"
      shift 2
      ;;
    --base-branch)
      BASE_BRANCH="${2:?missing --base-branch value}"
      shift 2
      ;;
    --origin)
      ORIGIN_REMOTE="${2:?missing --origin value}"
      shift 2
      ;;
    --work-root)
      WORK_ROOT="${2:?missing --work-root value}"
      shift 2
      ;;
    --lock-file)
      LOCK_FILE="${2:?missing --lock-file value}"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="${2:?missing --log-dir value}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

REPO_DIR="$(cd "$REPO_DIR" && pwd)"
GIT_DIR="$(git -C "$REPO_DIR" rev-parse --git-dir)"
if [[ "$GIT_DIR" != /* ]]; then
  GIT_DIR="$REPO_DIR/$GIT_DIR"
fi

if [ -z "$WORK_ROOT" ]; then
  WORK_ROOT="$GIT_DIR/gsd-upstream-sync-worktrees"
fi
if [ -z "$LOCK_FILE" ]; then
  LOCK_FILE="$GIT_DIR/gsd-upstream-sync.lock"
fi
if [ -z "$LOG_DIR" ]; then
  LOG_DIR="$GIT_DIR/gsd-upstream-sync-logs"
fi

mkdir -p "$WORK_ROOT" "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG_FILE") 2> >(tee -a "$LOG_FILE" >&2)

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  fail "Sync lock is already held: $LOCK_FILE"
fi

SYNC_BRANCH=""
SYNC_WORKTREE=""
BASE_PRESERVE_REF=""
CLEANED=0

cleanup() {
  local status=$?
  if [ "$CLEANED" -eq 0 ]; then
    CLEANED=1
    if [ -n "$SYNC_WORKTREE" ] && [ -d "$SYNC_WORKTREE/.git" ]; then
      git -C "$REPO_DIR" worktree remove --force "$SYNC_WORKTREE" >/dev/null 2>&1 || true
    fi
    if [ -n "$SYNC_BRANCH" ]; then
      git -C "$REPO_DIR" branch -D "$SYNC_BRANCH" >/dev/null 2>&1 || true
    fi
    rmdir "$LOCK_FILE" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

run() {
  log "+ $*"
  "$@"
}

read_preserve_paths() {
  if [ -n "${GSD_SYNC_PRESERVE_PATHS:-}" ]; then
    printf '%s\n' "$GSD_SYNC_PRESERVE_PATHS" | sed '/^[[:space:]]*$/d'
  else
    printf '%s\n' "${PRESERVE_PATHS_DEFAULT[@]}"
  fi
}

is_preserved_path() {
  local candidate="$1"
  local preserved
  while IFS= read -r preserved; do
    if [ "$candidate" = "$preserved" ] || [[ "$candidate" == "$preserved/"* ]]; then
      return 0
    fi
  done < <(read_preserve_paths)
  return 1
}

restore_path_from_base() {
  local preserved_path="$1"
  if git -C "$SYNC_WORKTREE" cat-file -e "${BASE_PRESERVE_REF}:${preserved_path}" 2>/dev/null; then
    git -C "$SYNC_WORKTREE" checkout "$BASE_PRESERVE_REF" -- "$preserved_path"
  else
    rm -rf "$SYNC_WORKTREE/$preserved_path"
    git -C "$SYNC_WORKTREE" rm -r --ignore-unmatch -- "$preserved_path" >/dev/null 2>&1 || true
  fi
}

restore_preserved_paths() {
  local preserved_path
  while IFS= read -r preserved_path; do
    restore_path_from_base "$preserved_path"
  done < <(read_preserve_paths)
  git -C "$SYNC_WORKTREE" add -A -- .github SECURITY.md hooks scripts >/dev/null 2>&1 || true
}

resolve_preserved_conflicts_or_fail() {
  local conflicts=()
  local conflict
  while IFS= read -r conflict; do
    conflicts+=("$conflict")
  done < <(git -C "$SYNC_WORKTREE" diff --name-only --diff-filter=U)

  if [ "${#conflicts[@]}" -eq 0 ]; then
    return 1
  fi

  for conflict in "${conflicts[@]}"; do
    if [ "$conflict" = "package.json" ]; then
      continue
    fi
    if ! is_preserved_path "$conflict"; then
      git -C "$SYNC_WORKTREE" merge --abort >/dev/null 2>&1 || true
      fail "Upstream merge has non-preserved conflict: $conflict"
    fi
  done

  log "Resolving merge conflicts from hardened local policy"
  for conflict in "${conflicts[@]}"; do
    if [ "$conflict" = "package.json" ]; then
      resolve_package_json_conflict
    else
      restore_path_from_base "$conflict"
    fi
  done
  git -C "$SYNC_WORKTREE" add -A
}

resolve_package_json_conflict() {
  log "Resolving package.json conflict by taking upstream package data and preserving local sync scripts"
  git -C "$SYNC_WORKTREE" checkout --theirs -- package.json
  (
    cd "$SYNC_WORKTREE"
    node <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts = pkg.scripts || {};
pkg.scripts['sync:upstream:unattended'] = 'bash scripts/unattended-upstream-sync.sh';
pkg.scripts['sync:upstream:dry-run'] = 'bash scripts/unattended-upstream-sync.sh --dry-run';
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  )
  git -C "$SYNC_WORKTREE" add package.json
}

candidate_has_changes() {
  ! git -C "$SYNC_WORKTREE" diff --quiet HEAD || ! git -C "$SYNC_WORKTREE" diff --cached --quiet
}

run_validation() {
  log "Running validation gates in $SYNC_WORKTREE"
  (
    cd "$SYNC_WORKTREE"
    test_log="$(mktemp "${TMPDIR:-/tmp}/gsd-sync-npm-test.XXXXXX")"
    npm_test_status=0
    npm test 2>&1 | tee "$test_log" || npm_test_status=$?
    if [ "$npm_test_status" -ne 0 ]; then
      rm -f "$test_log"
      exit "$npm_test_status"
    fi
    if grep -Eq '(^|[^[:alpha:]])fail[[:space:]]+[1-9][0-9]*|(^|[^[:alpha:]])failed[[:space:]]+[1-9][0-9]*|failing tests:' "$test_log"; then
      rm -f "$test_log"
      echo "npm test reported failing tests despite exit status 0" >&2
      exit 1
    fi
    rm -f "$test_log"
    LC_ALL=C scripts/prompt-injection-scan.sh --diff "$BASE_PRESERVE_REF"
    LC_ALL=C scripts/base64-scan.sh --diff "$BASE_PRESERVE_REF"
    LC_ALL=C scripts/secret-scan.sh --diff "$BASE_PRESERVE_REF"
  ) || fail "Validation failed"
}

promote_local_main() {
  local candidate_sha="$1"
  local current_branch
  current_branch="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

  if git -C "$REPO_DIR" merge-base --is-ancestor "$BASE_BRANCH" "$candidate_sha"; then
    if [ "$current_branch" = "$BASE_BRANCH" ]; then
      if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
        log "WARNING: checked-out ${BASE_BRANCH} has local changes; leaving local checkout untouched"
        return
      fi
      run git -C "$REPO_DIR" merge --ff-only "$candidate_sha"
    else
      run git -C "$REPO_DIR" branch -f "$BASE_BRANCH" "$candidate_sha"
    fi
    return
  fi

  fail "Local ${BASE_BRANCH} is not an ancestor of validated candidate; refusing unattended non-fast-forward promotion"
}

push_origin_main_best_effort() {
  local candidate_sha="$1"
  if run git -C "$SYNC_WORKTREE" push "$ORIGIN_REMOTE" "$candidate_sha:$BASE_BRANCH"; then
    log "Pushed ${ORIGIN_REMOTE}/${BASE_BRANCH}"
  else
    log "WARNING: unable to push ${ORIGIN_REMOTE}/${BASE_BRANCH}; local ${BASE_BRANCH} remains validated"
  fi
}

codex_home() {
  if [ -n "${CODEX_HOME:-}" ]; then
    printf '%s\n' "$CODEX_HOME"
  else
    printf '%s/.codex\n' "$HOME"
  fi
}

json_version() {
  node -e "process.stdout.write(require('./package.json').version)"
}

install_and_validate_codex() {
  local candidate_sha="$1"
  local expected_version
  local home_dir
  local temp_codex_home

  expected_version="$(cd "$SYNC_WORKTREE" && json_version)"
  home_dir="$(codex_home)"
  temp_codex_home="$(mktemp -d "${TMPDIR:-/tmp}/gsd-codex-install-smoke.XXXXXX")"

  if [ -f "$SYNC_WORKTREE/scripts/build-hooks.js" ]; then
    log "Building hooks before Codex install"
    (cd "$SYNC_WORKTREE" && node scripts/build-hooks.js) || fail "Hook build failed"
  fi

  log "Smoke-testing Codex install into temporary CODEX_HOME=$temp_codex_home"
  (
    cd "$SYNC_WORKTREE"
    CODEX_HOME="$temp_codex_home" node bin/install.js --codex --global --no-sdk
  ) || fail "Temporary Codex install smoke test failed"
  validate_codex_home "$temp_codex_home" "$expected_version"
  rm -rf "$temp_codex_home"

  log "Installing validated source into global Codex config at $home_dir"
  (
    cd "$SYNC_WORKTREE"
    CODEX_HOME="$home_dir" node bin/install.js --codex --global --no-sdk
  ) || fail "Codex global install failed"

  validate_codex_home "$home_dir" "$expected_version"
  mkdir -p "$home_dir/get-shit-done"
  {
    printf 'repo=%s\n' "$SYNC_WORKTREE"
    printf 'commit=%s\n' "$candidate_sha"
    printf 'version=%s\n' "$expected_version"
    printf 'installed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$home_dir/get-shit-done/SOURCE"

  if [ ! -f "$home_dir/get-shit-done/VERSION" ]; then
    fail "Codex install validation failed: missing $home_dir/get-shit-done/VERSION"
  fi
  if [ "$(tr -d '\r\n' < "$home_dir/get-shit-done/VERSION")" != "$expected_version" ]; then
    fail "Codex install validation failed: VERSION mismatch"
  fi
  if ! grep -q "commit=${candidate_sha}" "$home_dir/get-shit-done/SOURCE"; then
    fail "Codex install validation failed: SOURCE does not record candidate commit"
  fi

  log "Validated Codex install: version=$expected_version source=$candidate_sha"
}

validate_codex_home() {
  local home_dir="$1"
  local expected_version="$2"
  local skills_count
  local min_skills="${GSD_SYNC_MIN_SKILLS:-50}"

  if [ ! -f "$home_dir/get-shit-done/VERSION" ]; then
    fail "Codex install validation failed: missing $home_dir/get-shit-done/VERSION"
  fi
  if [ "$(tr -d '\r\n' < "$home_dir/get-shit-done/VERSION")" != "$expected_version" ]; then
    fail "Codex install validation failed: VERSION mismatch"
  fi

  skills_count="$(find "$home_dir/skills" -maxdepth 2 -path '*/gsd-*/SKILL.md' 2>/dev/null | wc -l | tr -d '[:space:]')"
  if [ "${skills_count:-0}" -lt "$min_skills" ]; then
    fail "Codex install validation failed: found ${skills_count:-0} gsd skills, expected at least $min_skills"
  fi

  if [ -d "$SYNC_WORKTREE/hooks/dist" ] && [ ! -f "$home_dir/hooks/gsd-check-update.js" ]; then
    fail "Codex install validation failed: missing $home_dir/hooks/gsd-check-update.js"
  fi

  log "Validated Codex home $home_dir: skills=$skills_count version=$expected_version"
}

log "Starting unattended upstream sync"
log "Repository: $REPO_DIR"
log "Origin: $ORIGIN_REMOTE/$BASE_BRANCH"
log "Upstream: $UPSTREAM_URL $UPSTREAM_REF"
log "Log file: $LOG_FILE"
if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run enabled; promotion, push, and install will be skipped"
fi
if [ "$SKIP_INSTALL" -eq 1 ]; then
  log "Skip install enabled; validated source will not be installed into Codex"
fi

run git -C "$REPO_DIR" fetch "$ORIGIN_REMOTE" "$BASE_BRANCH"
run git -C "$REPO_DIR" fetch "$UPSTREAM_URL" "$UPSTREAM_REF"
upstream_sha="$(git -C "$REPO_DIR" rev-parse FETCH_HEAD)"
BASE_PRESERVE_REF="$(git -C "$REPO_DIR" rev-parse "$BASE_BRANCH")"

SYNC_BRANCH="gsd-sync/upstream-${UPSTREAM_REF}-$(date -u +%Y%m%d%H%M%S)-$$"
SYNC_WORKTREE="$WORK_ROOT/${SYNC_BRANCH//\//-}"

run git -C "$REPO_DIR" branch "$SYNC_BRANCH" "$BASE_PRESERVE_REF"
run git -C "$REPO_DIR" worktree add --detach "$SYNC_WORKTREE" "$SYNC_BRANCH"
run git -C "$SYNC_WORKTREE" config user.name "GSD Upstream Sync"
run git -C "$SYNC_WORKTREE" config user.email "gsd-upstream-sync@local"

log "Reconciling fetched origin before upstream merge"
if ! git -C "$SYNC_WORKTREE" merge --ff-only "refs/remotes/${ORIGIN_REMOTE}/${BASE_BRANCH}"; then
  fail "Local ${BASE_BRANCH} and ${ORIGIN_REMOTE}/${BASE_BRANCH} have diverged; refusing unattended sync"
fi

log "Merging upstream candidate $upstream_sha into temporary candidate"
if ! git -C "$SYNC_WORKTREE" merge --no-ff --no-edit --no-commit "$upstream_sha"; then
  resolve_preserved_conflicts_or_fail
fi

restore_preserved_paths

if ! candidate_has_changes; then
  git -C "$SYNC_WORKTREE" merge --abort >/dev/null 2>&1 || true
  log "No upstream changes remain after preserving hardened files"
  exit 0
fi

run git -C "$SYNC_WORKTREE" commit -m "chore: sync upstream/${UPSTREAM_REF} into ${BASE_BRANCH}"
candidate_sha="$(git -C "$SYNC_WORKTREE" rev-parse HEAD)"
log "Validated candidate commit prepared: $candidate_sha"

run_validation

if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run enabled; validated candidate $candidate_sha was not promoted, pushed, or installed"
  exit 0
fi

promote_local_main "$candidate_sha"
push_origin_main_best_effort "$candidate_sha"
if [ "$SKIP_INSTALL" -eq 1 ]; then
  log "Skip install enabled; validated candidate $candidate_sha was promoted and pushed only"
else
  install_and_validate_codex "$candidate_sha"
fi

log "Unattended upstream sync completed"
