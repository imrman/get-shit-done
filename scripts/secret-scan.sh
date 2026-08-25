#!/usr/bin/env bash
# secret-scan.sh — Check files for accidentally committed secrets/credentials
#
# Usage:
#   scripts/secret-scan.sh --diff origin/main   # CI mode: scan changed files
#   scripts/secret-scan.sh --file path/to/file   # Scan a single file
#   scripts/secret-scan.sh --dir agents/          # Scan all files in a directory
#
# Exit codes:
#   0 = clean
#   1 = findings detected
#   2 = usage error
set -euo pipefail

# ─── Secret Patterns ─────────────────────────────────────────────────────────
# Format: "LABEL:::REGEX"
# Each entry is a human label paired with a POSIX extended regex.

SECRET_PATTERNS=(
  # AWS
  "AWS Access Key:::AKIA[0-9A-Z]{16}"
  "AWS Secret Key:::[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy][[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{40}"

  # OpenAI / Anthropic / AI providers
  "OpenAI Project API Key:::sk-proj-[A-Za-z0-9_-]{20,}"
  "OpenAI API Key:::sk-[A-Za-z0-9]{20,}"
  "Anthropic API Key:::sk-ant-[A-Za-z0-9_-]{20,}"

  # GitHub
  "GitHub PAT:::ghp_[A-Za-z0-9]{36}"
  "GitHub OAuth:::gho_[A-Za-z0-9]{36}"
  "GitHub User-to-Server Token:::ghu_[A-Za-z0-9]{36}"
  "GitHub App Token:::ghs_[A-Za-z0-9]{36}"
  "GitHub Refresh Token:::ghr_[A-Za-z0-9]{36}"
  "GitHub Fine-grained PAT:::github_pat_[A-Za-z0-9_]{20,}"

  # Stripe
  "Stripe Secret Key:::sk_live_[A-Za-z0-9]{24,}"
  "Stripe Publishable Key:::pk_live_[A-Za-z0-9]{24,}"

  # Generic patterns
  "Private Key Header:::-----BEGIN[[:space:]]+(RSA|EC|DSA|OPENSSH)?[[:space:]]*PRIVATE[[:space:]]+KEY-----"
  "Generic API Key Assignment:::(^|[^[:alnum:]_])[Aa][Pp][Ii][_-]?[Kk][Ee][Yy][[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{20,}['\"]"
  "Generic API Key Assignment:::(^|[^[:alnum:]_])([A-Z0-9]+_)*API[_-]?KEY[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_-]{20,}[[:space:]]*(#.*)?$"
  "Generic Secret Assignment:::(^|[^[:alnum:]_])[Ss][Ee][Cc][Rr][Ee][Tt][[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{20,}['\"]"
  "Generic Secret Assignment:::(^|[^[:alnum:]_])([A-Z0-9]+_)*SECRET[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_-]{20,}[[:space:]]*(#.*)?$"
  "Generic Token Assignment:::(^|[^[:alnum:]_])[Tt][Oo][Kk][Ee][Nn][[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{20,}['\"]"
  "Generic Token Assignment:::(^|[^[:alnum:]_])([A-Z0-9]+_)*TOKEN[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_-]{20,}[[:space:]]*(#.*)?$"
  "JWT Token Assignment:::[A-Za-z0-9_-]*[Tt][Oo][Kk][Ee][Nn][A-Za-z0-9_-]*[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}['\"]"
  "Dotted Token Assignment:::[A-Za-z0-9_-]*[Tt][Oo][Kk][Ee][Nn][A-Za-z0-9_-]*[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]{10,}['\"]"
  "Generic Password Assignment:::[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd][[:space:]]*[:=][[:space:]]*['\"][^'\"]{8,}['\"]"

  # Slack
  "Slack Bot Token:::xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}"
  "Slack Webhook:::hooks\.slack\.com/services/T[A-Z0-9]{8,}/B[A-Z0-9]{8,}/[A-Za-z0-9]{24}"

  # Google
  "Google API Key:::AIza[A-Za-z0-9_-]{35}"

  # NPM
  "NPM Token:::npm_[A-Za-z0-9]{36}"

  # .env file content (key=value with sensitive-looking keys)
  "Env Variable Leak:::(DATABASE_URL|DB_PASSWORD|REDIS_URL|MONGO_URI|JWT_SECRET|SESSION_SECRET|ENCRYPTION_KEY)[[:space:]]*=[[:space:]]*[^[:space:]]{8,}"
)

CONCAT_SECRET_PATTERNS=(
  "AWS Access Key:::AKIA[0-9A-Z]{16}"
  "OpenAI Project API Key:::sk-proj-[A-Za-z0-9_-]{20,}"
  "OpenAI API Key:::sk-[A-Za-z0-9]{20,}"
  "Anthropic API Key:::sk-ant-[A-Za-z0-9_-]{20,}"
  "GitHub PAT:::ghp_[A-Za-z0-9]{36}"
  "GitHub OAuth:::gho_[A-Za-z0-9]{36}"
  "GitHub User-to-Server Token:::ghu_[A-Za-z0-9]{36}"
  "GitHub App Token:::ghs_[A-Za-z0-9]{36}"
  "GitHub Refresh Token:::ghr_[A-Za-z0-9]{36}"
  "GitHub Fine-grained PAT:::github_pat_[A-Za-z0-9_]{20,}"
  "Stripe Secret Key:::sk_live_[A-Za-z0-9]{24,}"
  "Stripe Publishable Key:::pk_live_[A-Za-z0-9]{24,}"
  "Slack Bot Token:::xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}"
  "Google API Key:::AIza[A-Za-z0-9_-]{35}"
  "NPM Token:::npm_[A-Za-z0-9]{36}"
)

MAX_LITERAL_GAP_LINES=16
MAX_CONCATENATED_LITERALS=64
MAX_CONCATENATED_SECRET_LENGTH=512

# ─── Ignorelist ──────────────────────────────────────────────────────────────

IGNOREFILE=".secretscanignore"
IGNORED_FILES=()

load_ignorelist() {
  local trusted_base="${1:-}"
  local ignore_contents=""

  if [[ -n "$trusted_base" ]]; then
    ignore_contents="$(git show "$trusted_base:$IGNOREFILE" 2>/dev/null || true)"
  elif [[ -f "$IGNOREFILE" ]]; then
    ignore_contents="$(cat "$IGNOREFILE")"
  fi

  if [[ -n "$ignore_contents" ]]; then
    while IFS= read -r line; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "${line// }" ]] && continue
      IGNORED_FILES+=("$line")
    done <<< "$ignore_contents"
  fi
}

is_ignored() {
  local file="$1"
  if [[ ${#IGNORED_FILES[@]} -eq 0 ]]; then
    return 1
  fi
  for pattern in "${IGNORED_FILES[@]}"; do
    # Support glob-style matching
    # shellcheck disable=SC2254
    case "$file" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

# ─── Skip Rules ──────────────────────────────────────────────────────────────

normalize_repo_path() {
  local file="$1"
  file="${file//\\//}"
  while [[ "$file" == ./* ]]; do
    file="${file#./}"
  done
  printf '%s\n' "$file"
}

sanitize_file_id() {
  local name="$1"
  name="${name//\\//}"
  name="${name##*/}"
  printf '%s' "$name" | tr '\r\n\t' '   ' | sed -E '
    s/[[:space:]]+/ /g
    :redact
    s/(^|[^[:alnum:]])(customer|secret|token|password|passwd|credential|credentials|private|api[-_]?key|access[-_]?key)([^[:alnum:]]|$)/\1[redacted]\3/g
    tredact
    s/(AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|(ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|s[pk]_live_[A-Za-z0-9]{24,}|xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36})/[redacted]/g
  '
}

is_repo_security_scan_test() {
  local file
  file="$(normalize_repo_path "$1")"
  if [[ "$file" == "tests/security-scan.test.cjs" ]]; then
    return 0
  fi

  local cwd
  local absolute
  cwd="${PWD//\\//}"
  absolute="${1//\\//}"
  [[ "$absolute" == "$cwd/tests/security-scan.test.cjs" ]]
}

should_skip_file() {
  local file="$1"
  local mode="${2:-}"
  # Skip binary files
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot|*.otf) return 0 ;;
    *.zip|*.tar|*.gz|*.bz2|*.xz|*.7z) return 0 ;;
    *.pdf|*.doc|*.docx|*.xls|*.xlsx) return 0 ;;
  esac
  # Skip node_modules
  case "$file" in
    */node_modules/*) return 0 ;;
  esac
  # Skip the scan scripts themselves and test files
  case "$file" in
    */secret-scan.sh) [[ "$mode" != "--diff" ]] && return 0 ;;
  esac
  if [[ "$mode" != "--diff" ]] && is_repo_security_scan_test "$file"; then
    return 0
  fi
  return 1
}

is_readable_file() {
  [[ -f "$1" && -r "$1" ]]
}

reject_newline_path_fragments() {
  local -a files=("$@")
  local start end candidate
  for ((start = 0; start < ${#files[@]}; start += 1)); do
    candidate="${files[$start]}"
    for ((end = start + 1; end < ${#files[@]}; end += 1)); do
      candidate+=$'\n'"${files[$end]}"
      if is_readable_file "$candidate"; then
        echo "Error: stdin path stream cannot represent newline-containing paths" >&2
        exit 2
      fi
    done
  done
}

is_diff_candidate_file() {
  case "$1" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot|*.otf|*.zip|*.tar|*.gz|*.pdf) return 1 ;;
    *) return 0 ;;
  esac
}

add_diff_file() {
  local candidate="$1"
  local existing
  is_diff_candidate_file "$candidate" || return 0
  for existing in ${diff_files[@]+"${diff_files[@]}"}; do
    if [[ "$existing" == "$candidate" ]]; then
      return 0
    fi
  done
  diff_files+=("$candidate")
}

read_git_diff_paths() {
  local error_message="$1"
  shift
  local paths_tmp
  local file
  paths_tmp="$(mktemp "${TMPDIR:-/tmp}/secret-scan-paths.XXXXXX")"
  if ! git "$@" > "$paths_tmp" 2>/dev/null; then
    rm -f "$paths_tmp"
    echo "$error_message" >&2
    exit 2
  fi
  while IFS= read -r -d '' file; do
    add_diff_file "$file"
  done < "$paths_tmp"
  rm -f "$paths_tmp"
}

# ─── File Collection ─────────────────────────────────────────────────────────

collect_files() {
  local mode="$1"
  shift

  case "$mode" in
    --diff)
      local base="${1:-origin/main}"
      local -a diff_files=()
      read_git_diff_paths "Error: git diff failed for base: $base" diff -z --name-only --diff-filter=ACMR "$base"...HEAD
      read_git_diff_paths "Error: git staged diff failed" diff -z --name-only --cached --diff-filter=ACMR
      read_git_diff_paths "Error: git unstaged diff failed" diff -z --name-only --diff-filter=ACMR
      read_git_diff_paths "Error: git untracked file listing failed" ls-files -z --others --exclude-standard
      local file
      for file in "${diff_files[@]}"; do
        printf '%s\0' "$file"
      done
      ;;
    --file)
      if [[ -f "$1" ]]; then
        printf '%s\0' "$1"
      else
        echo "Error: file not found: $1" >&2
        exit 2
      fi
      ;;
    --dir)
      local dir="$1"
      if [[ ! -d "$dir" ]]; then
        echo "Error: directory not found: $dir" >&2
        exit 2
      fi
      find "$dir" -type f ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/dist/*' \
        ! -name '*.png' ! -name '*.jpg' ! -name '*.gif' ! -name '*.woff*' -print0 2>/dev/null || true
      ;;
    --stdin)
      local -a stdin_files=()
      while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        stdin_files+=("$file")
      done
      reject_newline_path_fragments "${stdin_files[@]}"
      for file in "${stdin_files[@]}"; do
        if ! is_readable_file "$file"; then
          echo "Error: stdin path is not readable" >&2
          exit 2
        fi
        printf '%s\0' "$file"
      done
      ;;
    *)
      echo "Usage: $0 --diff [base] | --file <path> | --dir <path> | --stdin" >&2
      exit 2
      ;;
  esac
}

# ─── Scanner ─────────────────────────────────────────────────────────────────

is_allowed_concatenated_literal_fixture() {
  local file
  file="$(normalize_repo_path "$1")"
  local line_num="$2"
  [[ "$file" == "tests/workflow-token-hardening.test.cjs" ]] || return 1

  local start=$((line_num > 3 ? line_num - 3 : 1))
  local fixture_block
  fixture_block="$(sed -n "${start},$((line_num + 4))p" -- "$1" 2>/dev/null || true)"
  [[ "$fixture_block" == *'const tokenLikePath = ['* ]] || return 1
  [[ "$fixture_block" == *"'.planning/TOKEN_',"* ]] || return 1
  [[ "$fixture_block" == *"].join('');"* ]]
}

find_concatenated_literal_secret() {
  local file="$1"
  local -a literal_lines=()
  local -a literal_values=()
  local match line_num quoted value

  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    line_num="${match%%:*}"
    quoted="${match#*:}"
    value="${quoted:1:${#quoted}-2}"
    literal_lines+=("$line_num")
    literal_values+=("$value")
  done < <(grep -nEo -e "['\"][A-Za-z0-9_-]{1,}['\"]" -- "$file" 2>/dev/null || true)

  local start end joined entry label pattern
  for ((start = 0; start < ${#literal_values[@]}; start += 1)); do
    joined=""
    for ((end = start; end < ${#literal_values[@]} && end < start + MAX_CONCATENATED_LITERALS; end += 1)); do
      if [[ $((literal_lines[$end] - literal_lines[$start])) -gt $MAX_LITERAL_GAP_LINES ]]; then
        break
      fi
      joined+="${literal_values[$end]}"
      [[ ${#joined} -gt $MAX_CONCATENATED_SECRET_LENGTH ]] && break
      [[ $end -eq $start || ${#joined} -lt 20 ]] && continue

      for entry in "${CONCAT_SECRET_PATTERNS[@]}"; do
        label="${entry%%:::*}"
        pattern="${entry#*:::}"
        if [[ "$joined" =~ $pattern ]]; then
          if is_allowed_concatenated_literal_fixture "$file" "${literal_lines[$start]}"; then
            continue
          fi
          printf '%s:::%s\n' "$label" "${literal_lines[$start]}"
          return 0
        fi
      done
    done
  done
  return 1
}

scan_file() {
  local file="$1"
  local found=0

  if is_ignored "$file"; then
    return 0
  fi

  for entry in "${SECRET_PATTERNS[@]}"; do
    local label="${entry%%:::*}"
    local pattern="${entry#*:::}"

    local matches
    matches=$(grep -nE -e "$pattern" -- "$file" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      if [[ $found -eq 0 ]]; then
        echo "FAIL: $(sanitize_file_id "$file")"
        found=1
      fi
      echo "$matches" | while IFS= read -r line; do
        local line_num="${line%%:*}"
        echo "  [$label] line $line_num: matched pattern"
        echo "    pattern: $pattern"
      done
    fi
  done

  local concatenated_match
  if concatenated_match="$(find_concatenated_literal_secret "$file")"; then
    local label="${concatenated_match%%:::*}"
    local line_num="${concatenated_match#*:::}"
    if [[ $found -eq 0 ]]; then
      echo "FAIL: $(sanitize_file_id "$file")"
      found=1
    fi
    echo "  [$label] line $line_num: matched reconstructed quoted literals"
    echo "    pattern: normalized provider credential"
  fi

  return $found
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  if [[ $# -eq 0 ]]; then
    echo "Usage: $0 --diff [base] | --file <path> | --dir <path>" >&2
    exit 2
  fi

  local mode="$1"
  shift
  local trusted_ignore_base=""
  if [[ "$mode" == "--diff" ]]; then
    trusted_ignore_base="${1:-origin/main}"
  fi

  load_ignorelist "$trusted_ignore_base"

  local files_tmp
  files_tmp="$(mktemp "${TMPDIR:-/tmp}/secret-scan.XXXXXX")"
  collect_files "$mode" "$@" > "$files_tmp"

  local seen=0
  local total=0
  local failed=0

  while IFS= read -r -d '' file; do
    seen=1
    if should_skip_file "$file" "$mode"; then
      continue
    fi
    total=$((total + 1))
    if ! scan_file "$file"; then
      failed=$((failed + 1))
    fi
  done < "$files_tmp"
  rm -f "$files_tmp"

  if [[ $seen -eq 0 ]]; then
    echo "secret-scan: no files to scan"
    exit 0
  fi

  echo ""
  echo "secret-scan: scanned $total files, $failed with findings"

  if [[ $failed -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
