#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH="main"
DRY_RUN=0
REQUIRE_PUSH=0
REQUIRE_STABLE_UPSTREAM_REF=0
ALLOW_VALIDATION_REJECTION=0
SKIP_INSTALL=1
TRUSTED_PROMOTE_ONLY=0
IDENTITY_ATTEST_ONLY=0
LOCK_FILE=""
LOG_DIR=""
OUTCOME_FILE=""
ORIGIN_REMOTE="origin"
REPO_DIR="$(pwd)"
UPSTREAM_REF="main"
UPSTREAM_URL="https://github.com/gsd-build/get-shit-done.git"
EXPECTED_UPSTREAM_SHA=""
EXPECTED_ORIGIN_SHA="${EXPECTED_ORIGIN_SHA:-}"
EXPECTED_CANDIDATE_TREE_SHA="${EXPECTED_CANDIDATE_TREE_SHA:-}"
WORK_ROOT=""
GITHUB_EXTRAHEADER_KEY="http.https://github.com/.extraheader"

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
  "scripts/unattended-upstream-sync.sh"
)

TRUSTED_VALIDATION_POLICY_PATHS=(
  ".base64scanignore"
  ".secretscanignore"
)

TRUSTED_VALIDATION_BYTES_PATHS=(
  "scripts/run-tests.cjs"
  "tests"
)

usage() {
  cat <<EOF
Usage: scripts/unattended-upstream-sync.sh [options]

Fetch origin/main and an upstream release ref into a temporary worktree, merge upstream,
preserve local hardened security/automation files, validate, promote main, and push.

Options:
  --repo <path>           Repository checkout to coordinate from (default: cwd)
  --upstream-url <url>    Upstream repository URL (default: ${UPSTREAM_URL})
  --upstream-ref <ref>    Upstream ref to merge (default: ${UPSTREAM_REF})
  --expected-upstream-sha <sha>
                          Require fetched upstream ref to resolve to this SHA
  --expected-origin-sha <sha>
                          Require fetched origin/base branch to resolve to this SHA
  --expected-candidate-tree-sha <sha>
                          Require recomputed candidate content tree to match this SHA
  --require-stable-upstream-ref
                          Require --upstream-ref to be a stable release tag
                          (vX.Y.Z or X.Y.Z; rejects branches and prereleases)
  --base-branch <branch>  Local/origin branch to update (default: ${BASE_BRANCH})
  --origin <remote>       Origin remote name (default: ${ORIGIN_REMOTE})
  --work-root <path>      Parent directory for temporary worktrees
  --lock-file <path>      Lock directory path
  --log-dir <path>        Directory for run logs
  --outcome-file <path>   Atomic one-line outcome channel; path must be an
                          absolute direct child of RUNNER_TEMP
  --dry-run               Validate only; skip promotion, push, and install
  --require-push          Fail if pushing the validated candidate fails
  --trusted-promote-only  Recompute, promote, and push without candidate
                          validation; use only after a separate validation
                          runner has succeeded
  --identity-attest-only Recompute origin, upstream, and candidate-tree
                          identities without validation or promotion
  --allow-validation-rejection
                          Persist rejected candidate identity for duplicate
                          suppression; new rejections exit 2 and suppressed
                          repeats exit 3
  --skip-install          Kept for compatibility; install is disabled by default
  -h, --help              Show this help

Environment:
  GSD_SYNC_PRESERVE_PATHS Newline-separated paths to preserve from origin/main
  GSD_SYNC_MIN_SKILLS     Minimum expected gsd-* Codex skills after install (default: 50)
  RUNNER_TEMP             Trusted parent directory required by --outcome-file
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
    --expected-upstream-sha)
      EXPECTED_UPSTREAM_SHA="${2:?missing --expected-upstream-sha value}"
      shift 2
      ;;
    --expected-origin-sha)
      EXPECTED_ORIGIN_SHA="${2:?missing --expected-origin-sha value}"
      shift 2
      ;;
    --expected-candidate-tree-sha)
      EXPECTED_CANDIDATE_TREE_SHA="${2:?missing --expected-candidate-tree-sha value}"
      shift 2
      ;;
    --base-branch)
      BASE_BRANCH="${2:?missing --base-branch value}"
      shift 2
      ;;
    --require-stable-upstream-ref)
      REQUIRE_STABLE_UPSTREAM_REF=1
      shift
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
    --outcome-file)
      if [ "$#" -lt 2 ]; then
        echo "missing --outcome-file value" >&2
        exit 64
      fi
      OUTCOME_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --require-push)
      REQUIRE_PUSH=1
      shift
      ;;
    --trusted-promote-only)
      TRUSTED_PROMOTE_ONLY=1
      shift
      ;;
    --identity-attest-only)
      IDENTITY_ATTEST_ONLY=1
      shift
      ;;
    --allow-validation-rejection)
      ALLOW_VALIDATION_REJECTION=1
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

# Ignore inherited Git repository, helper, config, and replacement injection in this security boundary.
unset \
  GIT_DIR \
  GIT_WORK_TREE \
  GIT_INDEX_FILE \
  GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_COMMON_DIR \
  GIT_NAMESPACE \
  GIT_SSH \
  GIT_SSH_COMMAND \
  GIT_SSH_VARIANT \
  GIT_ASKPASS \
  SSH_ASKPASS \
  GIT_PROXY_COMMAND \
  GIT_EXEC_PATH \
  GIT_TEMPLATE_DIR
export GIT_CONFIG_COUNT=0
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_PARAMETERS=
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_NO_REPLACE_OBJECTS=1

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
BLOCKED_STATE_FILE="$GIT_DIR/gsd-upstream-sync-blocked-state"

PUSH_AUTH_HEADER=""
if [ -n "${GH_PUSH_TOKEN:-}" ]; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    printf '::add-mask::%s\n' "$GH_PUSH_TOKEN"
  fi
  PUSH_AUTH_HEADER="$(printf 'x-access-token:%s' "$GH_PUSH_TOKEN" | base64 | tr -d '\n')"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    printf '::add-mask::%s\n' "$PUSH_AUTH_HEADER"
  fi
fi
unset GH_PUSH_TOKEN

mkdir -p "$WORK_ROOT" "$LOG_DIR"
CANDIDATE_VALIDATION_GIT_CONFIG_GLOBAL="$WORK_ROOT/candidate-validation-global-$$.gitconfig"
: > "$CANDIDATE_VALIDATION_GIT_CONFIG_GLOBAL"
CANDIDATE_VALIDATION_HOME="$(mktemp -d "$WORK_ROOT/candidate-validation-home.XXXXXX")"
CANDIDATE_VALIDATION_CODEX_HOME="$CANDIDATE_VALIDATION_HOME/.codex"
CANDIDATE_VALIDATION_NPM_CACHE="$CANDIDATE_VALIDATION_HOME/.npm-cache"
CANDIDATE_VALIDATION_XDG_CONFIG_HOME="$CANDIDATE_VALIDATION_HOME/.config"
CANDIDATE_VALIDATION_XDG_CACHE_HOME="$CANDIDATE_VALIDATION_HOME/.cache"
CANDIDATE_VALIDATION_XDG_DATA_HOME="$CANDIDATE_VALIDATION_HOME/.local/share"
mkdir -p \
  "$CANDIDATE_VALIDATION_CODEX_HOME" \
  "$CANDIDATE_VALIDATION_NPM_CACHE" \
  "$CANDIDATE_VALIDATION_XDG_CONFIG_HOME" \
  "$CANDIDATE_VALIDATION_XDG_CACHE_HOME" \
  "$CANDIDATE_VALIDATION_XDG_DATA_HOME"
LOG_FILE="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ).log"
LOG_PIPE_DIR=""
LOG_STDOUT_PIPE=""
LOG_STDERR_PIPE=""
LOG_STDOUT_TEE_PID=""
LOG_STDERR_TEE_PID=""

setup_logging() {
  exec 3>&1 4>&2

  LOG_PIPE_DIR="$(mktemp -d "$LOG_DIR/gsd-sync-logger.XXXXXX")"
  LOG_STDOUT_PIPE="$LOG_PIPE_DIR/stdout.pipe"
  LOG_STDERR_PIPE="$LOG_PIPE_DIR/stderr.pipe"
  mkfifo "$LOG_STDOUT_PIPE" "$LOG_STDERR_PIPE"

  tee -a "$LOG_FILE" <"$LOG_STDOUT_PIPE" >&3 &
  LOG_STDOUT_TEE_PID=$!
  tee -a "$LOG_FILE" <"$LOG_STDERR_PIPE" >&4 &
  LOG_STDERR_TEE_PID=$!

  exec >"$LOG_STDOUT_PIPE" 2>"$LOG_STDERR_PIPE"
}

teardown_logging() {
  exec 1>&3 2>&4
  exec 3>&- 4>&-

  if [ -n "$LOG_STDOUT_TEE_PID" ]; then
    wait "$LOG_STDOUT_TEE_PID" 2>/dev/null || true
  fi
  if [ -n "$LOG_STDERR_TEE_PID" ]; then
    wait "$LOG_STDERR_TEE_PID" 2>/dev/null || true
  fi

  rm -f "$LOG_STDOUT_PIPE" "$LOG_STDERR_PIPE"
  rmdir "$LOG_PIPE_DIR" 2>/dev/null || true
}

setup_logging

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

validate_outcome_file() {
  local outcome_parent
  local outcome_parent_physical
  local outcome_name
  local runner_temp_physical

  if [ -z "$OUTCOME_FILE" ]; then
    return
  fi
  case "$OUTCOME_FILE" in
    /*) ;;
    *) fail "Outcome file must be an absolute path" ;;
  esac
  case "$OUTCOME_FILE" in
    *$'\n'*|*$'\r'*) fail "Outcome file must not contain control characters" ;;
  esac
  if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then
    fail "--outcome-file requires an existing RUNNER_TEMP directory"
  fi
  runner_temp_physical="$(cd "$RUNNER_TEMP" && pwd -P)" || fail "Unable to resolve RUNNER_TEMP"
  outcome_parent="$(dirname -- "$OUTCOME_FILE")"
  if [ ! -d "$outcome_parent" ]; then
    fail "Outcome file parent directory must exist"
  fi
  outcome_parent_physical="$(cd "$outcome_parent" && pwd -P)" || fail "Unable to resolve outcome file parent"
  if [ "$outcome_parent_physical" != "$runner_temp_physical" ]; then
    fail "Outcome file must be a direct child of RUNNER_TEMP"
  fi
  outcome_name="$(basename -- "$OUTCOME_FILE")"
  if [ -L "$OUTCOME_FILE" ]; then
    fail "Outcome file must not be a symlink"
  fi
  if [ -e "$OUTCOME_FILE" ] && [ ! -f "$OUTCOME_FILE" ]; then
    fail "Outcome file must be a regular file"
  fi
  OUTCOME_FILE="$runner_temp_physical/$outcome_name"
}

replace_outcome_file() {
  local content="$1"
  local outcome_tmp

  if [ -z "$OUTCOME_FILE" ]; then
    return
  fi
  outcome_tmp="$(mktemp "${OUTCOME_FILE}.tmp.XXXXXX")" || fail "Unable to create outcome file"
  chmod 600 "$outcome_tmp" || {
    rm -f -- "$outcome_tmp"
    fail "Unable to secure outcome file"
  }
  printf '%s' "$content" > "$outcome_tmp" || {
    rm -f -- "$outcome_tmp"
    fail "Unable to write outcome file"
  }
  if ! mv -f -- "$outcome_tmp" "$OUTCOME_FILE"; then
    rm -f -- "$outcome_tmp"
    fail "Unable to publish outcome file"
  fi
}

write_sync_outcome() {
  replace_outcome_file "SYNC_OUTCOME=$1"$'\n'
}

SYNC_BRANCH=""
SYNC_WORKTREE=""
SCANNER_VIEW=""
SCANNER_VIEW_PARENT=""
INSTALL_WORKTREE=""
INSTALL_WORKTREE_PARENT=""
PUSH_WORKTREE=""
PUSH_WORKTREE_PARENT=""
BASE_PRESERVE_REF=""
TRUSTED_ORIGIN_URL=""
CANDIDATE_VALIDATION_GIT_CONFIG_GLOBAL="${CANDIDATE_VALIDATION_GIT_CONFIG_GLOBAL:-}"
CANDIDATE_VALIDATION_HOME="${CANDIDATE_VALIDATION_HOME:-}"
CLEANED=0
PRESERVE_PATHS=()

cleanup_git_credentials_in_repo() {
  local repo_dir="$1"
  if [ -n "$repo_dir" ] && [ -e "$repo_dir/.git" ]; then
    git -C "$repo_dir" config --local --unset-all "$GITHUB_EXTRAHEADER_KEY" >/dev/null 2>&1 || true
  fi
}

cleanup_git_push_credentials() {
  cleanup_git_credentials_in_repo "$REPO_DIR"
  cleanup_git_credentials_in_repo "$SYNC_WORKTREE"
  cleanup_git_credentials_in_repo "$PUSH_WORKTREE"
}

sanitize_local_git_trust_boundary_config() {
  local repo_dir="$1"
  local repo_label="$2"
  local removed_sensitive_git_config=0
  local sensitive_config_key

  if [ -n "$repo_dir" ] && [ -e "$repo_dir/.git" ]; then
    git -C "$repo_dir" config --local --unset-all core.hooksPath >/dev/null 2>&1 || true
    while IFS= read -r -d '' sensitive_config_key; do
      git -C "$repo_dir" config --local --unset-all "$sensitive_config_key" >/dev/null 2>&1 || true
      removed_sensitive_git_config=1
      git -C "$repo_dir" config --worktree --unset-all "$sensitive_config_key" >/dev/null 2>&1 || true
    done < <(git -C "$repo_dir" config --null --name-only --get-regexp '^(include\.path|includeif\..*\.path|url\..*\.(insteadof|pushinsteadof)|credential\.|http\.|https\.|protocol\.|filter\.|core\.(attributesfile|gitproxy)$|extensions\.worktreeconfig$|remote\..*\.(proxy|proxyauthmethod)$)' 2>/dev/null || true)
    if [ "$removed_sensitive_git_config" -eq 1 ]; then
      log "Removed candidate-controlled Git trust-boundary config from $repo_label"
    fi
  fi
}

sanitize_candidate_git_config_after_validation() {
  sanitize_local_git_trust_boundary_config "$SYNC_WORKTREE" "sync worktree"
}

sanitize_push_git_config_before_push() {
  sanitize_local_git_trust_boundary_config "$PUSH_WORKTREE" "push worktree"
}

sanitize_repo_git_config_before_fetch() {
  sanitize_local_git_trust_boundary_config "$REPO_DIR" "repository"
}

cleanup_sync_worktree() {
  local sync_top
  local sync_worktree_physical

  if [ -z "$SYNC_WORKTREE" ]; then
    return
  fi

  case "$SYNC_WORKTREE" in
    "$WORK_ROOT"/*)
      ;;
    *)
      log "WARNING: refusing to remove sync worktree outside work root: $SYNC_WORKTREE"
      return
      ;;
  esac

  if [ ! -e "$SYNC_WORKTREE/.git" ]; then
    return
  fi

  sync_top="$(git -C "$SYNC_WORKTREE" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$sync_top" ]; then
    sync_top="$(cd "$sync_top" && pwd -P)" || sync_top=""
  fi
  sync_worktree_physical="$(cd "$SYNC_WORKTREE" && pwd -P)" || sync_worktree_physical=""
  if [ -z "$sync_top" ] || [ "$sync_top" != "$sync_worktree_physical" ]; then
    log "WARNING: refusing to remove unexpected sync worktree path: $SYNC_WORKTREE"
    return
  fi

  git -C "$REPO_DIR" worktree remove --force "$SYNC_WORKTREE" >/dev/null 2>&1 || true
}

cleanup_scanner_view() {
  if [ -z "$SCANNER_VIEW_PARENT" ]; then
    return
  fi

  case "$SCANNER_VIEW_PARENT" in
    "$WORK_ROOT"/trusted-scanner.*)
      rm -rf -- "$SCANNER_VIEW_PARENT"
      ;;
    *)
      log "WARNING: refusing to remove trusted scanner view outside work root: $SCANNER_VIEW_PARENT"
      ;;
  esac
  SCANNER_VIEW=""
  SCANNER_VIEW_PARENT=""
}

cleanup_install_worktree() {
  local install_top
  local install_parent_physical
  local install_worktree_physical

  if [ -z "$INSTALL_WORKTREE" ]; then
    return
  fi

  if [ -z "$INSTALL_WORKTREE_PARENT" ]; then
    log "WARNING: refusing to remove install worktree without recorded parent: $INSTALL_WORKTREE"
    return
  fi

  case "$INSTALL_WORKTREE" in
    "$INSTALL_WORKTREE_PARENT"/*)
      ;;
    *)
      log "WARNING: refusing to remove install worktree outside recorded parent: $INSTALL_WORKTREE"
      return
      ;;
  esac

  if [ ! -e "$INSTALL_WORKTREE/.git" ]; then
    rmdir "$INSTALL_WORKTREE" 2>/dev/null || true
    rmdir "$INSTALL_WORKTREE_PARENT" 2>/dev/null || true
    return
  fi

  install_top="$(git -C "$INSTALL_WORKTREE" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$install_top" ]; then
    install_top="$(cd "$install_top" && pwd -P)" || install_top=""
  fi
  install_worktree_physical="$(cd "$INSTALL_WORKTREE" && pwd -P)" || install_worktree_physical=""
  install_parent_physical="$(cd "$INSTALL_WORKTREE_PARENT" && pwd -P)" || install_parent_physical=""
  case "$install_worktree_physical" in
    "$install_parent_physical"/*)
      ;;
    *)
      log "WARNING: refusing to remove install worktree outside recorded parent: $INSTALL_WORKTREE"
      return
      ;;
  esac
  if [ -z "$install_top" ] || [ "$install_top" != "$install_worktree_physical" ]; then
    log "WARNING: refusing to remove unexpected install worktree path: $INSTALL_WORKTREE"
    return
  fi

  git -C "$REPO_DIR" worktree remove --force "$INSTALL_WORKTREE" >/dev/null 2>&1 || true
  rmdir "$INSTALL_WORKTREE_PARENT" 2>/dev/null || true
}

cleanup_push_worktree() {
  local push_parent_physical
  local push_top
  local push_worktree_physical

  if [ -z "$PUSH_WORKTREE" ]; then
    return
  fi

  if [ -z "$PUSH_WORKTREE_PARENT" ]; then
    log "WARNING: refusing to remove push worktree without recorded parent: $PUSH_WORKTREE"
    return
  fi

  case "$PUSH_WORKTREE" in
    "$PUSH_WORKTREE_PARENT"/*)
      ;;
    *)
      log "WARNING: refusing to remove push worktree outside recorded parent: $PUSH_WORKTREE"
      return
      ;;
  esac

  if [ ! -e "$PUSH_WORKTREE/.git" ]; then
    rmdir "$PUSH_WORKTREE" 2>/dev/null || true
    rmdir "$PUSH_WORKTREE_PARENT" 2>/dev/null || true
    return
  fi

  push_top="$(git -C "$PUSH_WORKTREE" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$push_top" ]; then
    push_top="$(cd "$push_top" && pwd -P)" || push_top=""
  fi
  push_worktree_physical="$(cd "$PUSH_WORKTREE" && pwd -P)" || push_worktree_physical=""
  push_parent_physical="$(cd "$PUSH_WORKTREE_PARENT" && pwd -P)" || push_parent_physical=""
  case "$push_worktree_physical" in
    "$push_parent_physical"/*)
      ;;
    *)
      log "WARNING: refusing to remove push worktree outside recorded parent: $PUSH_WORKTREE"
      return
      ;;
  esac
  if [ -z "$push_top" ] || [ "$push_top" != "$push_worktree_physical" ]; then
    log "WARNING: refusing to remove unexpected push worktree path: $PUSH_WORKTREE"
    return
  fi

  rm -rf -- "$PUSH_WORKTREE"
  rmdir "$PUSH_WORKTREE_PARENT" 2>/dev/null || true
}

cleanup() {
  local status=$?
  if [ "$CLEANED" -eq 0 ]; then
    CLEANED=1
    cleanup_git_push_credentials
    cleanup_push_worktree
    cleanup_install_worktree
    cleanup_scanner_view
    cleanup_sync_worktree
    if [ -n "$SYNC_BRANCH" ]; then
      git -C "$REPO_DIR" branch -D "$SYNC_BRANCH" >/dev/null 2>&1 || true
    fi
    if [ -n "$CANDIDATE_VALIDATION_GIT_CONFIG_GLOBAL" ]; then
      rm -f "$CANDIDATE_VALIDATION_GIT_CONFIG_GLOBAL"
    fi
    if [ -n "$CANDIDATE_VALIDATION_HOME" ]; then
      case "$CANDIDATE_VALIDATION_HOME" in
        "$WORK_ROOT"/*)
          rm -rf -- "$CANDIDATE_VALIDATION_HOME"
          ;;
        *)
          log "WARNING: refusing to remove candidate validation HOME outside work root: $CANDIDATE_VALIDATION_HOME"
          ;;
      esac
    fi
    rmdir "$LOCK_FILE" >/dev/null 2>&1 || true
    teardown_logging
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  fail "Sync lock is already held: $LOCK_FILE"
fi
validate_outcome_file
replace_outcome_file ""

run() {
  log "+ $*"
  "$@"
}

trusted_git() {
  GIT_CONFIG_COUNT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_PARAMETERS= GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 git "$@"
}

run_trusted_git() {
  log "+ git $*"
  trusted_git "$@"
}

candidate_validation_command() {
  local safe_var
  local -a candidate_env

  candidate_env=(
    env -i
    "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
    "HOME=$CANDIDATE_VALIDATION_HOME"
    "CODEX_HOME=$CANDIDATE_VALIDATION_CODEX_HOME"
    "NPM_CONFIG_CACHE=$CANDIDATE_VALIDATION_NPM_CACHE"
    "npm_config_cache=$CANDIDATE_VALIDATION_NPM_CACHE"
    "NPM_CONFIG_USERCONFIG=$CANDIDATE_VALIDATION_HOME/.npmrc"
    "npm_config_userconfig=$CANDIDATE_VALIDATION_HOME/.npmrc"
    "XDG_CONFIG_HOME=$CANDIDATE_VALIDATION_XDG_CONFIG_HOME"
    "XDG_CACHE_HOME=$CANDIDATE_VALIDATION_XDG_CACHE_HOME"
    "XDG_DATA_HOME=$CANDIDATE_VALIDATION_XDG_DATA_HOME"
    "GIT_CONFIG_GLOBAL=$CANDIDATE_VALIDATION_GIT_CONFIG_GLOBAL"
    "GIT_CONFIG_NOSYSTEM=1"
  )

  for safe_var in \
    CI \
    TMPDIR \
    VALIDATION_LOG
  do
    if [ -n "${!safe_var+x}" ]; then
      candidate_env+=("$safe_var=${!safe_var}")
    fi
  done

  "${candidate_env[@]}" "$@"
}

trusted_validation_command() {
  GIT_CONFIG_COUNT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_PARAMETERS= GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 "$@"
}

run_trusted_scanner() {
  local scanner_path="$1"

  if [ "$scanner_path" = "scripts/base64-scan.sh" ]; then
    trusted_git -C "$REPO_DIR" show "${BASE_PRESERVE_REF}:scripts/base64-scan.cjs" |
      trusted_validation_command env LC_ALL=C node - --diff "$BASE_PRESERVE_REF"
    return
  fi

  trusted_git -C "$REPO_DIR" show "${BASE_PRESERVE_REF}:${scanner_path}" |
    trusted_validation_command env LC_ALL=C /bin/bash -s -- --diff "$BASE_PRESERVE_REF"
}

redact_url_credentials() {
  sed -E 's#([[:alpha:]][[:alnum:]+.-]*://)[^/@[:space:]]+@#\1<redacted>@#g'
}

fetch_upstream() {
  local redacted_upstream_url
  redacted_upstream_url="$(printf '%s\n' "$UPSTREAM_URL" | redact_url_credentials)"

  log "+ git -C $REPO_DIR fetch $redacted_upstream_url $UPSTREAM_REF"
  trusted_git -C "$REPO_DIR" fetch "$UPSTREAM_URL" "$UPSTREAM_REF"
}

push_trusted_origin() {
  local candidate_sha="$1"
  local push_log
  local push_status=0

  sanitize_push_git_config_before_push
  log "+ git -C $PUSH_WORKTREE -c core.hooksPath=/dev/null push <trusted-${ORIGIN_REMOTE}-url> $candidate_sha:refs/heads/$BASE_BRANCH"
  push_log="$(mktemp "${TMPDIR:-/tmp}/gsd-sync-push.XXXXXX")"
  if [ -n "$PUSH_AUTH_HEADER" ]; then
    trusted_git -C "$PUSH_WORKTREE" -c core.hooksPath=/dev/null -c "$GITHUB_EXTRAHEADER_KEY=AUTHORIZATION: basic ${PUSH_AUTH_HEADER}" push "$TRUSTED_ORIGIN_URL" "$candidate_sha:refs/heads/$BASE_BRANCH" >"$push_log" 2>&1 || push_status=$?
  else
    trusted_git -C "$PUSH_WORKTREE" -c core.hooksPath=/dev/null push "$TRUSTED_ORIGIN_URL" "$candidate_sha:refs/heads/$BASE_BRANCH" >"$push_log" 2>&1 || push_status=$?
  fi
  if [ -s "$push_log" ]; then
    redact_url_credentials < "$push_log"
  fi
  rm -f "$push_log"
  return "$push_status"
}

validate_preserve_path() {
  local preserve_path="$1"

  case "$preserve_path" in
    ""|"."|"..")
      fail "Unsafe preserve path: $preserve_path"
      ;;
    /*)
      fail "Unsafe preserve path uses absolute path: $preserve_path"
      ;;
    -*)
      fail "Unsafe preserve path starts with dash: $preserve_path"
      ;;
    :*)
      fail "Unsafe preserve path uses pathspec magic: $preserve_path"
      ;;
    *'*'*|*'?'*|*'['*)
      fail "Unsafe preserve path uses wildcard metacharacter: $preserve_path"
      ;;
    */|*//*)
      fail "Unsafe preserve path has empty component: $preserve_path"
      ;;
    ./*|*/./*|*/.)
      fail "Unsafe preserve path has current-directory component: $preserve_path"
      ;;
    ../*|*/../*|*/..)
      fail "Unsafe preserve path has parent traversal: $preserve_path"
      ;;
  esac
}

load_preserve_paths() {
  local preserve_path
  PRESERVE_PATHS=()

  if [ -n "${GSD_SYNC_PRESERVE_PATHS:-}" ]; then
    while IFS= read -r preserve_path || [ -n "$preserve_path" ]; do
      if [ -z "${preserve_path//[[:space:]]/}" ]; then
        continue
      fi
      validate_preserve_path "$preserve_path"
      PRESERVE_PATHS+=("$preserve_path")
    done <<< "$GSD_SYNC_PRESERVE_PATHS"
  else
    for preserve_path in "${PRESERVE_PATHS_DEFAULT[@]}"; do
      validate_preserve_path "$preserve_path"
      PRESERVE_PATHS+=("$preserve_path")
    done
  fi
}

is_preserved_path() {
  local candidate="$1"
  local preserved
  for preserved in "${PRESERVE_PATHS[@]}"; do
    if [ "$candidate" = "$preserved" ] || [[ "$candidate" == "$preserved/"* ]]; then
      return 0
    fi
  done
  return 1
}

require_stable_upstream_ref() {
  local ref="$1"
  local tag="${ref#refs/tags/}"

  if [[ "$tag" =~ ^v?[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
    return 0
  fi

  fail "Upstream ref must be an official stable release tag (vX.Y.Z or X.Y.Z), got: $ref"
}

require_commit_sha() {
  local sha="$1"
  local label="$2"

  if [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    return 0
  fi

  fail "$label must be a full lowercase 40-character commit SHA, got: $sha"
}

require_object_sha() {
  local sha="$1"
  local label="$2"

  if [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    return 0
  fi

  fail "$label must be a full lowercase 40-character SHA, got: $sha"
}

emit_candidate_identity() {
  local candidate_tree_sha="$1"

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      printf 'origin_sha=%s\n' "$origin_sha"
      printf 'upstream_sha=%s\n' "$upstream_sha"
      printf 'candidate_tree_sha=%s\n' "$candidate_tree_sha"
    } >> "$GITHUB_OUTPUT"
  fi
}

blocked_candidate_state() {
  printf '%s\n' \
    'version=1' \
    "origin_sha=$origin_sha" \
    "upstream_ref=$UPSTREAM_REF" \
    "upstream_sha=$upstream_sha" \
    "candidate_tree_sha=$candidate_tree_sha"
}

blocked_candidate_is_unchanged() {
  [ -f "$BLOCKED_STATE_FILE" ] &&
    [ ! -L "$BLOCKED_STATE_FILE" ] &&
    cmp -s "$BLOCKED_STATE_FILE" <(blocked_candidate_state)
}

record_blocked_candidate() {
  local state_tmp

  state_tmp="$(mktemp "${BLOCKED_STATE_FILE}.tmp.XXXXXX")" || return 1
  chmod 600 "$state_tmp" || {
    rm -f -- "$state_tmp"
    return 1
  }
  blocked_candidate_state > "$state_tmp" || {
    rm -f -- "$state_tmp"
    return 1
  }
  mv -f -- "$state_tmp" "$BLOCKED_STATE_FILE"
}

emit_sync_outcome() {
  local outcome="$1"
  local reason="${2:-}"
  local summary="SYNC_OUTCOME=$outcome"

  if [ -n "$reason" ]; then
    summary="$summary reason=$reason"
  fi
  write_sync_outcome "$outcome"
  log "$summary origin_sha=$origin_sha upstream_ref=$UPSTREAM_REF upstream_sha=$upstream_sha candidate_tree_sha=$candidate_tree_sha"
}

assert_preserved_restore_path_safe() {
  local preserved_path="$1"
  local physical_root
  local current_path
  local component
  local resolved_path
  local index=0
  local total
  local -a components

  physical_root="$(cd "$SYNC_WORKTREE" && pwd -P)" || fail "Unable to resolve sync worktree path"
  current_path="$SYNC_WORKTREE"

  IFS='/' read -r -a components <<< "$preserved_path"
  total="${#components[@]}"

  for component in "${components[@]}"; do
    index=$((index + 1))
    current_path="$current_path/$component"

    if [ -L "$current_path" ]; then
      fail "Unsafe preserved path has symlink component before restore: $preserved_path"
    fi

    if [ -e "$current_path" ]; then
      if [ "$index" -lt "$total" ] && [ ! -d "$current_path" ]; then
        fail "Unsafe preserved path ancestor is not a directory before restore: $preserved_path"
      fi

      if [ -d "$current_path" ]; then
        resolved_path="$(cd "$current_path" && pwd -P)" || fail "Unable to resolve preserved path before restore: $preserved_path"
        case "$resolved_path" in
          "$physical_root"|"$physical_root"/*)
            ;;
          *)
            fail "Unsafe preserved path resolves outside sync worktree before restore: $preserved_path"
            ;;
        esac
      fi
    fi
  done
}

restore_path_from_base() {
  local preserved_path="$1"
  assert_preserved_restore_path_safe "$preserved_path"
  if git -C "$SYNC_WORKTREE" cat-file -e "${BASE_PRESERVE_REF}:${preserved_path}" 2>/dev/null; then
    rm -rf -- "$SYNC_WORKTREE/$preserved_path"
    git -C "$SYNC_WORKTREE" rm -r --ignore-unmatch -- "$preserved_path" >/dev/null 2>&1 || true
    git -C "$SYNC_WORKTREE" checkout "$BASE_PRESERVE_REF" -- "$preserved_path"
  else
    rm -rf -- "$SYNC_WORKTREE/$preserved_path"
    git -C "$SYNC_WORKTREE" rm -r --ignore-unmatch -- "$preserved_path" >/dev/null 2>&1 || true
  fi
}

restore_preserved_paths() {
  local preserved_path
  for preserved_path in "${PRESERVE_PATHS[@]}"; do
    restore_path_from_base "$preserved_path"
  done
  git -C "$SYNC_WORKTREE" add -A -- .github SECURITY.md hooks scripts >/dev/null 2>&1 || true
}

restore_trusted_validation_policy_paths() {
  local policy_path
  for policy_path in "${TRUSTED_VALIDATION_POLICY_PATHS[@]}"; do
    restore_path_from_base "$policy_path"
  done
  git -C "$SYNC_WORKTREE" add -A -- "${TRUSTED_VALIDATION_POLICY_PATHS[@]}" >/dev/null 2>&1 || true
}

materialize_trusted_validation_bytes() {
  local validation_path
  for validation_path in "${TRUSTED_VALIDATION_BYTES_PATHS[@]}"; do
    restore_path_from_base "$validation_path"
  done
}

remove_candidate_npm_configs() {
  local npm_config_path

  while IFS= read -r -d '' npm_config_path; do
    rm -f -- "$npm_config_path"
  done < <(find "$SYNC_WORKTREE" -name .npmrc -print0)
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
      resolve_package_json_conflict
    elif is_preserved_path "$conflict"; then
      restore_path_from_base "$conflict"
    else
      resolve_non_preserved_conflict_from_upstream "$conflict"
    fi
  done
  git -C "$SYNC_WORKTREE" add -A
}

resolve_non_preserved_conflict_from_upstream() {
  local conflict="$1"

  log "Resolving non-preserved merge conflict from upstream: $conflict"
  if git -C "$SYNC_WORKTREE" cat-file -e ":3:${conflict}" 2>/dev/null; then
    git -C "$SYNC_WORKTREE" checkout --theirs -- "$conflict"
    git -C "$SYNC_WORKTREE" add -- "$conflict"
  else
    git -C "$SYNC_WORKTREE" rm -r --ignore-unmatch -- "$conflict" >/dev/null 2>&1 || true
  fi
}

resolve_package_json_conflict() {
  log "Resolving package.json conflict by taking upstream package data and preserving trusted scripts"
  git -C "$SYNC_WORKTREE" checkout --theirs -- package.json
  preserve_package_json_sync_scripts
  git -C "$SYNC_WORKTREE" add package.json
}

preserve_package_json_sync_scripts() {
  if [ ! -f "$SYNC_WORKTREE/package.json" ]; then
    return
  fi

  (
    cd "$SYNC_WORKTREE"
    node 3< <(trusted_git -C "$REPO_DIR" show "${BASE_PRESERVE_REF}:package.json") <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const basePkg = JSON.parse(fs.readFileSync(3, 'utf8'));
const validationScripts = ['test', 'pretest', 'pretest:coverage', 'build:sdk', 'lint:skill-deps'];
pkg.scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
  ? pkg.scripts
  : {};
const baseScripts = basePkg.scripts && typeof basePkg.scripts === 'object' && !Array.isArray(basePkg.scripts)
  ? basePkg.scripts
  : {};
for (const scriptName of validationScripts) {
  if (Object.hasOwn(baseScripts, scriptName)) {
    pkg.scripts[scriptName] = baseScripts[scriptName];
  }
}
pkg.scripts['sync:upstream:unattended'] = 'bash scripts/unattended-upstream-sync.sh';
pkg.scripts['sync:upstream:dry-run'] = 'bash scripts/unattended-upstream-sync.sh --dry-run';
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  )
}

candidate_has_changes() {
  ! git -C "$SYNC_WORKTREE" diff --quiet HEAD || ! git -C "$SYNC_WORKTREE" diff --cached --quiet
}

run_validation() {
  local candidate_sha="$1"
  local test_status=0

  log "Running validation gates in $SYNC_WORKTREE"
  (
    cd "$SYNC_WORKTREE"
    materialize_trusted_validation_bytes
    remove_candidate_npm_configs
    test_log="$(mktemp "${TMPDIR:-/tmp}/gsd-sync-npm-test.XXXXXX")"
    npm_test_status=0
    candidate_validation_command npm --ignore-scripts=false test 2>&1 | tee "$test_log" || npm_test_status=$?
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
  ) || test_status=$?
  if [ "$test_status" -ne 0 ]; then
    return "$test_status"
  fi
  restore_validated_candidate_worktree "$candidate_sha"
  prepare_trusted_scanner_view "$candidate_sha"
  log "Running trusted scanners from pinned ${ORIGIN_REMOTE}/${BASE_BRANCH} bytes against immutable candidate content"
  (
    cd "$SCANNER_VIEW"
    run_trusted_scanner scripts/prompt-injection-scan.sh || exit $?
    run_trusted_scanner scripts/base64-scan.sh || exit $?
    run_trusted_scanner scripts/secret-scan.sh || exit $?
  )
}

restore_validated_candidate_worktree() {
  local candidate_sha="$1"

  sanitize_candidate_git_config_after_validation
  log "Restoring sync worktree to validated candidate commit: $candidate_sha"
  run_trusted_git -C "$SYNC_WORKTREE" reset --hard "$candidate_sha"
  run_trusted_git -C "$SYNC_WORKTREE" clean -fdx
}

prepare_trusted_scanner_view() {
  local candidate_sha="$1"

  SCANNER_VIEW_PARENT="$(mktemp -d "$WORK_ROOT/trusted-scanner.XXXXXX")"
  SCANNER_VIEW="$SCANNER_VIEW_PARENT/candidate"
  run_trusted_git clone --no-checkout --shared "$REPO_DIR" "$SCANNER_VIEW"
  sanitize_local_git_trust_boundary_config "$SCANNER_VIEW" "trusted scanner view"
  run_trusted_git -C "$SCANNER_VIEW" checkout --detach "$candidate_sha"
  run_trusted_git -C "$SCANNER_VIEW" clean -fdx
  if ! trusted_git -C "$SCANNER_VIEW" diff --quiet --no-ext-diff --no-textconv "$candidate_sha" --; then
    fail "Trusted scanner view differs from committed candidate content: $candidate_sha"
  fi
}

prepare_install_worktree() {
  local candidate_sha="$1"

  if [ -n "$INSTALL_WORKTREE" ]; then
    return
  fi

  INSTALL_WORKTREE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/gsd-install.XXXXXX")"
  INSTALL_WORKTREE="$(mktemp -d "$INSTALL_WORKTREE_PARENT/candidate.XXXXXX")"
  run_trusted_git -C "$REPO_DIR" worktree add --detach "$INSTALL_WORKTREE" "$candidate_sha"
  log "Prepared fresh install source at validated candidate commit: $candidate_sha"
  run_trusted_git -C "$INSTALL_WORKTREE" reset --hard "$candidate_sha"
  run_trusted_git -C "$INSTALL_WORKTREE" clean -fdx
}

prepare_push_worktree() {
  local candidate_sha="$1"

  if [ -n "$PUSH_WORKTREE" ]; then
    return
  fi

  PUSH_WORKTREE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/gsd-push.XXXXXX")"
  PUSH_WORKTREE="$(mktemp -d "$PUSH_WORKTREE_PARENT/candidate.XXXXXX")"
  run_trusted_git clone --no-checkout --shared "$REPO_DIR" "$PUSH_WORKTREE"
  run_trusted_git -C "$PUSH_WORKTREE" checkout --detach "$candidate_sha"
  log "Prepared fresh push source at validated candidate commit: $candidate_sha"
  run_trusted_git -C "$PUSH_WORKTREE" reset --hard "$candidate_sha"
  run_trusted_git -C "$PUSH_WORKTREE" clean -fdx
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
  cleanup_git_push_credentials
  sanitize_candidate_git_config_after_validation
  prepare_push_worktree "$candidate_sha"
  if [ -n "$PUSH_AUTH_HEADER" ]; then
    log "Configured GitHub push credentials for remote push"
  fi

  if push_trusted_origin "$candidate_sha"; then
    cleanup_git_push_credentials
    log "Pushed ${ORIGIN_REMOTE}/${BASE_BRANCH}"
  else
    cleanup_git_push_credentials
    if [ "$REQUIRE_PUSH" -eq 1 ]; then
      fail "Unable to push ${ORIGIN_REMOTE}/${BASE_BRANCH}"
    fi
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
  local install_source
  local temp_codex_home

  prepare_install_worktree "$candidate_sha"
  install_source="$INSTALL_WORKTREE"
  expected_version="$(cd "$install_source" && json_version)"
  home_dir="$(codex_home)"
  temp_codex_home="$(mktemp -d "${TMPDIR:-/tmp}/gsd-codex-install-smoke.XXXXXX")"

  if [ -f "$install_source/scripts/build-hooks.js" ]; then
    log "Building hooks before Codex install"
    (cd "$install_source" && node scripts/build-hooks.js) || fail "Hook build failed"
  fi

  log "Smoke-testing Codex install into temporary CODEX_HOME=$temp_codex_home"
  (
    cd "$install_source"
    CODEX_HOME="$temp_codex_home" node bin/install.js --codex --global --no-sdk
  ) || fail "Temporary Codex install smoke test failed"
  validate_codex_home "$temp_codex_home" "$expected_version"
  rm -rf "$temp_codex_home"

  log "Installing validated source into global Codex config at $home_dir"
  (
    cd "$install_source"
    CODEX_HOME="$home_dir" node bin/install.js --codex --global --no-sdk
  ) || fail "Codex global install failed"

  validate_codex_home "$home_dir" "$expected_version"
  mkdir -p "$home_dir/get-shit-done"
  {
    printf 'repo=%s\n' "$install_source"
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
  local source_dir="${INSTALL_WORKTREE:-$SYNC_WORKTREE}"
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

  if [ -d "$source_dir/hooks/dist" ] && [ ! -f "$home_dir/hooks/gsd-check-update.js" ]; then
    fail "Codex install validation failed: missing $home_dir/hooks/gsd-check-update.js"
  fi

  log "Validated Codex home $home_dir: skills=$skills_count version=$expected_version"
}

log "Starting unattended upstream sync"
log "Repository: $REPO_DIR"
log "Origin: $ORIGIN_REMOTE/$BASE_BRANCH"
log "Upstream: $(printf '%s\n' "$UPSTREAM_URL" | redact_url_credentials) $UPSTREAM_REF"
log "Log file: $LOG_FILE"
if [ "$REQUIRE_STABLE_UPSTREAM_REF" -eq 1 ]; then
  require_stable_upstream_ref "$UPSTREAM_REF"
  log "Stable upstream release ref required and accepted: $UPSTREAM_REF"
fi
if [ -n "$EXPECTED_UPSTREAM_SHA" ]; then
  require_commit_sha "$EXPECTED_UPSTREAM_SHA" "Expected upstream SHA"
  log "Expected upstream SHA required: $EXPECTED_UPSTREAM_SHA"
fi
if [ -n "$EXPECTED_ORIGIN_SHA" ]; then
  require_commit_sha "$EXPECTED_ORIGIN_SHA" "Expected origin SHA"
  log "Expected origin SHA required: $EXPECTED_ORIGIN_SHA"
fi
if [ -n "$EXPECTED_CANDIDATE_TREE_SHA" ]; then
  require_object_sha "$EXPECTED_CANDIDATE_TREE_SHA" "Expected candidate tree SHA"
  log "Expected candidate tree SHA required: $EXPECTED_CANDIDATE_TREE_SHA"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run enabled; promotion and push will be skipped"
fi
if [ "$TRUSTED_PROMOTE_ONLY" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    fail "--trusted-promote-only cannot be combined with --dry-run"
  fi
  if [ "$ALLOW_VALIDATION_REJECTION" -eq 1 ]; then
    fail "--trusted-promote-only cannot be combined with --allow-validation-rejection"
  fi
  if [ -z "$EXPECTED_UPSTREAM_SHA" ] || [ -z "$EXPECTED_ORIGIN_SHA" ] || [ -z "$EXPECTED_CANDIDATE_TREE_SHA" ]; then
    fail "Trusted promotion requires --expected-upstream-sha, --expected-origin-sha, and --expected-candidate-tree-sha from a successful validation run"
  fi
  SKIP_INSTALL=1
  log "Trusted promotion mode enabled; candidate validation is skipped in this runner"
elif [ "$IDENTITY_ATTEST_ONLY" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ] || [ "$REQUIRE_PUSH" -eq 1 ] || [ "$ALLOW_VALIDATION_REJECTION" -eq 1 ]; then
    fail "--identity-attest-only cannot validate, push, or soft-fail validation"
  fi
  if [ -n "$PUSH_AUTH_HEADER" ]; then
    fail "Identity attestation must not receive push credentials"
  fi
  if [ -z "${GITHUB_OUTPUT:-}" ]; then
    fail "Identity attestation requires GITHUB_OUTPUT"
  fi
  SKIP_INSTALL=1
  log "Identity attestation mode enabled; candidate code, validation, promotion, push, and install are disabled"
elif [ -n "$PUSH_AUTH_HEADER" ]; then
  fail "Authenticated push requires --trusted-promote-only after separate candidate validation"
fi
if [ "$SKIP_INSTALL" -eq 1 ]; then
  log "Install is disabled by default; run a separate trusted install from the validated SHA"
  log "Skip install enabled; validated source will not be installed into Codex"
fi
if [ "$ALLOW_VALIDATION_REJECTION" -eq 1 ]; then
  log "Validation rejection tracking enabled; new rejections fail and identical repeats are suppressed"
fi
load_preserve_paths
cleanup_git_push_credentials
log "Cleared GitHub push credentials before validation"
sanitize_repo_git_config_before_fetch

run_trusted_git -C "$REPO_DIR" fetch "$ORIGIN_REMOTE" "$BASE_BRANCH"
TRUSTED_ORIGIN_URL="$(trusted_git -C "$REPO_DIR" remote get-url "$ORIGIN_REMOTE")"
log "Captured trusted ${ORIGIN_REMOTE} fetch URL for authenticated push"
origin_sha="$(trusted_git -C "$REPO_DIR" rev-parse FETCH_HEAD)"
if [ -n "$EXPECTED_ORIGIN_SHA" ] && [ "$origin_sha" != "$EXPECTED_ORIGIN_SHA" ]; then
  fail "Origin $BASE_BRANCH resolved to $origin_sha, expected $EXPECTED_ORIGIN_SHA"
fi
local_base_sha="$(trusted_git -C "$REPO_DIR" rev-parse "$BASE_BRANCH")"
if ! trusted_git -C "$REPO_DIR" merge-base --is-ancestor "$local_base_sha" "$origin_sha" &&
   ! trusted_git -C "$REPO_DIR" merge-base --is-ancestor "$origin_sha" "$local_base_sha"; then
  fail "Local ${BASE_BRANCH} and fetched ${ORIGIN_REMOTE}/${BASE_BRANCH} have diverged; refusing unattended sync"
fi
fetch_upstream
upstream_sha="$(trusted_git -C "$REPO_DIR" rev-parse FETCH_HEAD)"
if [ -n "$EXPECTED_UPSTREAM_SHA" ] && [ "$upstream_sha" != "$EXPECTED_UPSTREAM_SHA" ]; then
  fail "Upstream ref $UPSTREAM_REF resolved to $upstream_sha, expected $EXPECTED_UPSTREAM_SHA"
fi
BASE_PRESERVE_REF="$origin_sha"

SYNC_BRANCH="gsd-sync/upstream-${UPSTREAM_REF}-$(date -u +%Y%m%d%H%M%S)-$$"
SYNC_WORKTREE="$WORK_ROOT/${SYNC_BRANCH//\//-}"

run_trusted_git -C "$REPO_DIR" branch "$SYNC_BRANCH" "$local_base_sha"
run_trusted_git -C "$REPO_DIR" worktree add --detach "$SYNC_WORKTREE" "$SYNC_BRANCH"
run_trusted_git -C "$SYNC_WORKTREE" config user.name "GSD Upstream Sync"
run_trusted_git -C "$SYNC_WORKTREE" config user.email "gsd-upstream-sync@local"

log "Reconciling fetched origin before upstream merge"
if ! trusted_git -C "$SYNC_WORKTREE" -c core.hooksPath=/dev/null merge --ff-only "refs/remotes/${ORIGIN_REMOTE}/${BASE_BRANCH}"; then
  fail "Local ${BASE_BRANCH} and ${ORIGIN_REMOTE}/${BASE_BRANCH} have diverged; refusing unattended sync"
fi

log "Merging upstream candidate $upstream_sha into temporary candidate"
log "Using upstream-preferred merge resolution for non-preserved paths; hardened preserve paths are restored after merge"
if ! trusted_git -C "$SYNC_WORKTREE" -c core.hooksPath=/dev/null merge --no-ff --no-edit --no-commit -X theirs "$upstream_sha"; then
  resolve_preserved_conflicts_or_fail
fi

restore_preserved_paths
restore_trusted_validation_policy_paths
preserve_package_json_sync_scripts
trusted_git -C "$SYNC_WORKTREE" add package.json >/dev/null 2>&1 || true

if ! candidate_has_changes; then
  candidate_tree_sha="$(trusted_git -C "$SYNC_WORKTREE" rev-parse HEAD^{tree})"
  if [ -n "$EXPECTED_CANDIDATE_TREE_SHA" ] && [ "$candidate_tree_sha" != "$EXPECTED_CANDIDATE_TREE_SHA" ]; then
    fail "Candidate tree resolved to $candidate_tree_sha, expected $EXPECTED_CANDIDATE_TREE_SHA"
  fi
  emit_candidate_identity "$candidate_tree_sha"
  trusted_git -C "$SYNC_WORKTREE" -c core.hooksPath=/dev/null merge --abort >/dev/null 2>&1 || true
  emit_sync_outcome "NO_CHANGE" "UP_TO_DATE"
  log "No upstream changes remain after preserving hardened files"
  exit 0
fi

run_trusted_git -C "$SYNC_WORKTREE" -c core.hooksPath=/dev/null commit -m "chore: sync upstream/${UPSTREAM_REF} into ${BASE_BRANCH}"
candidate_sha="$(trusted_git -C "$SYNC_WORKTREE" rev-parse HEAD)"
candidate_tree_sha="$(trusted_git -C "$SYNC_WORKTREE" rev-parse "$candidate_sha^{tree}")"
if [ -n "$EXPECTED_CANDIDATE_TREE_SHA" ] && [ "$candidate_tree_sha" != "$EXPECTED_CANDIDATE_TREE_SHA" ]; then
  fail "Candidate tree resolved to $candidate_tree_sha, expected $EXPECTED_CANDIDATE_TREE_SHA"
fi
if [ "$TRUSTED_PROMOTE_ONLY" -eq 1 ]; then
  log "Candidate commit prepared for trusted promotion: $candidate_sha"
elif [ "$IDENTITY_ATTEST_ONLY" -eq 1 ]; then
  emit_candidate_identity "$candidate_tree_sha"
  write_sync_outcome "IDENTITY_ATTESTED"
  log "Candidate identities attested without executing candidate code"
  exit 0
else
  log "Candidate commit prepared for validation: $candidate_sha"
fi

if [ "$ALLOW_VALIDATION_REJECTION" -eq 1 ] &&
   [ "$TRUSTED_PROMOTE_ONLY" -eq 0 ] &&
   [ "$IDENTITY_ATTEST_ONLY" -eq 0 ] &&
   blocked_candidate_is_unchanged; then
  emit_sync_outcome "BLOCKED_VALIDATION_SUPPRESSED"
  log "Unchanged blocked candidate was not validated again; ${BASE_BRANCH} remains unchanged"
  exit 3
fi

if [ "$TRUSTED_PROMOTE_ONLY" -eq 0 ]; then
  if ! run_validation "$candidate_sha"; then
    if ! record_blocked_candidate; then
      log "WARNING: unable to persist blocked candidate identity at $BLOCKED_STATE_FILE"
    fi
    emit_sync_outcome "BLOCKED_VALIDATION"
    if [ "$ALLOW_VALIDATION_REJECTION" -eq 1 ]; then
      log "Validation rejected upstream candidate $candidate_sha; ${BASE_BRANCH} was not promoted, pushed, or installed"
      exit 2
    fi
    fail "Validation failed"
  fi
  log "Validation accepted candidate commit: $candidate_sha"
  emit_candidate_identity "$candidate_tree_sha"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  write_sync_outcome "VALIDATED"
  log "Dry run enabled; validated candidate $candidate_sha was not promoted or pushed"
  exit 0
fi

restore_validated_candidate_worktree "$candidate_sha"
promote_local_main "$candidate_sha"
push_origin_main_best_effort "$candidate_sha"
if [ "$SKIP_INSTALL" -eq 1 ]; then
  log "Skip install enabled; validated candidate $candidate_sha was promoted and pushed only"
else
  install_and_validate_codex "$candidate_sha"
fi

write_sync_outcome "PROMOTED"
log "Unattended upstream sync completed"
