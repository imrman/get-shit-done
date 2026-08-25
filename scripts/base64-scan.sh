#!/usr/bin/env bash
# base64-scan.sh — Detect base64-obfuscated prompt injection in source files
#
# Extracts base64 blobs >= 40 chars, decodes them, and checks decoded content
# against the same injection patterns used by prompt-injection-scan.sh.
#
# Usage:
#   scripts/base64-scan.sh --diff origin/main   # CI mode: scan changed files
#   scripts/base64-scan.sh --file path/to/file   # Scan a single file
#   scripts/base64-scan.sh --dir agents/          # Scan all files in a directory
#
# Exit codes:
#   0 = clean
#   1 = findings detected
#   2 = usage error
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v node >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/base64-scan.cjs" ]]; then
  exec node "$SCRIPT_DIR/base64-scan.cjs" "$@"
fi

MIN_BLOB_LENGTH=40
MAX_DECODE_DEPTH=3
MAX_FRAGMENT_GAP_LINES=16
MAX_RECONSTRUCTED_FRAGMENTS=128
MAX_RECONSTRUCTED_BLOB_LENGTH=65536

# ─── Injection Patterns (decoded content) ────────────────────────────────────
# Subset of patterns — if someone base64-encoded something, check for the
# most common injection indicators.
DECODED_PATTERNS=(
  'ignore[[:space:]]+(all[[:space:]]+)?previous[[:space:]]+instructions'
  'you[[:space:]]+are[[:space:]]+now[[:space:]]+'
  'system[[:space:]]+prompt'
  '</?system>'
  '</?assistant>'
  '\[SYSTEM\]'
  '\[INST\]'
  '<<SYS>>'
  'override[[:space:]]+(system|safety|security)'
  'pretend[[:space:]]+(you|to)[[:space:]]'
  'act[[:space:]]+as[[:space:]]+(a|an|if)'
  'jailbreak'
  'bypass[[:space:]]+(safety|content|security)'
  'eval[[:space:]]*\('
  'exec[[:space:]]*\('
  'rm[[:space:]]+-rf'
  'curl[[:space:]].*\|[[:space:]]*sh'
  'wget[[:space:]].*\|[[:space:]]*sh'
  'AKIA[0-9A-Z]{16}'
  'sk-proj-[A-Za-z0-9_-]{20,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  '(ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9]{36}'
  'github_pat_[A-Za-z0-9_]{20,}'
  's[pk]_live_[A-Za-z0-9]{24,}'
  'xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}'
  'AIza[A-Za-z0-9_-]{35}'
  'npm_[A-Za-z0-9]{36}'
)

# ─── Ignorelist ──────────────────────────────────────────────────────────────

IGNOREFILE=".base64scanignore"
IGNORED_PATTERNS=()

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
      # Skip comments and empty lines
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "${line// }" ]] && continue
      IGNORED_PATTERNS+=("$line")
    done <<< "$ignore_contents"
  fi
}

is_ignored() {
  local blob="$1"
  if [[ ${#IGNORED_PATTERNS[@]} -eq 0 ]]; then
    return 1
  fi
  for pattern in "${IGNORED_PATTERNS[@]}"; do
    if [[ "$blob" == "$pattern" ]]; then
      return 0
    fi
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
  paths_tmp="$(mktemp "${TMPDIR:-/tmp}/base64-scan-paths.XXXXXX")"
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

should_skip_file() {
  local file="$1"
  local mode="${2:-}"
  # Skip binary files
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot|*.otf) return 0 ;;
    *.zip|*.tar|*.gz|*.bz2|*.xz|*.7z) return 0 ;;
    *.pdf|*.doc|*.docx|*.xls|*.xlsx) return 0 ;;
  esac
  # Skip lockfiles and node_modules
  case "$file" in
    */node_modules/*) return 0 ;;
    */package-lock.json) return 0 ;;
    */yarn.lock) return 0 ;;
    */pnpm-lock.yaml) return 0 ;;
  esac
  # Skip the scan scripts themselves and test files
  case "$file" in
    */base64-scan.sh) [[ "$mode" != "--diff" ]] && return 0 ;;
  esac
  if [[ "$mode" != "--diff" ]] && is_repo_security_scan_test "$file"; then
    return 0
  fi
  return 1
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

check_base64_blob() {
  local file="$1"
  local blob="$2"
  local line_num="$3"
  local scan_line="$4"
  local already_found="$5"

  [[ -z "$blob" ]] && return 1

  local blob_len=${#blob}
  local blob_remainder=$((blob_len % 4))
  if [[ $blob_len -lt $MIN_BLOB_LENGTH || $blob_remainder -eq 1 ]]; then
    return 1
  fi

  # Plain alphanumeric source text often matches the broad base64
  # character class. Only decode ambiguous unpadded blobs when the
  # surrounding line looks like encoded data rather than prose/code words.
  if [[ "$blob" != *"+"* && "$blob" != *"/"* && "$blob" != *"="* && "$blob" != *"-"* && "$blob" != *"_"* ]]; then
    local trimmed_scan_line
    trimmed_scan_line="$(printf '%s' "$scan_line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    if [[ "$trimmed_scan_line" != "$blob" ]] && ! printf '%s\n' "$scan_line" | grep -iqE '(base64|encoded|payload|blob|secret|token|data|["'\''`:={}])' 2>/dev/null; then
      return 1
    fi
  fi

  if [[ ${#IGNORED_PATTERNS[@]} -gt 0 ]] && is_ignored "$blob"; then
    return 1
  fi

  local current_blob="$blob"
  local depth
  for ((depth = 0; depth < MAX_DECODE_DEPTH; depth += 1)); do
    local current_len=${#current_blob}
    local current_remainder=$((current_len % 4))
    local normalized_blob="$current_blob"
    normalized_blob="${normalized_blob//-/+}"
    normalized_blob="${normalized_blob//_/\/}"
    if [[ $current_remainder -gt 0 ]]; then
      normalized_blob="${normalized_blob}$(printf '%*s' $((4 - current_remainder)) '' | tr ' ' '=')"
    fi

    local decoded
    decoded=$(printf '%s' "$normalized_blob" | base64 -d 2>/dev/null || echo "")
    [[ -z "$decoded" ]] && return 1

    local total_chars=${#decoded}
    local printable_count
    printable_count=$(echo -n "$decoded" | tr -cd '[:print:]' | wc -c | tr -d ' ')
    if [[ $total_chars -eq 0 || $((printable_count * 100 / total_chars)) -lt 70 ]]; then
      return 1
    fi

    local canonical_blob
    local normalized_unpadded
    canonical_blob="$(printf '%s' "$decoded" | base64 | tr -d '\n=')"
    normalized_unpadded="${normalized_blob%%=*}"
    [[ "$canonical_blob" != "$normalized_unpadded" ]] && return 1

    local pattern
    for pattern in "${DECODED_PATTERNS[@]}"; do
      if echo "$decoded" | grep -iqE "$pattern" 2>/dev/null; then
        if [[ $already_found -eq 0 ]]; then
          echo "FAIL: $(sanitize_file_id "$file")"
        fi
        echo "  line $line_num: base64 blob decodes to suspicious content"
        echo "    matched: $pattern"
        return 0
      fi
    done

    if ! printf '%s\n' "$decoded" | grep -qE '^[A-Za-z0-9+/_-]{40,}={0,3}$' 2>/dev/null; then
      return 1
    fi
    current_blob="$decoded"
  done

  return 1
}

extract_quoted_base64_fragments() {
  printf '%s\n' "$1" |
    grep -oE "[\"'\`][A-Za-z0-9+\\/_-]{1,}={0,3}[\"'\`]" 2>/dev/null |
    sed -E "s/^[\"'\`]//; s/[\"'\`]$//"
}

extract_and_check_blobs() {
  local file="$1"
  local found=0
  local line_num=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_num=$((line_num + 1))
    local scan_line
    scan_line="$line"

    # Extract base64-like blobs, including URL-safe - and _ candidates.
    local blobs
    blobs=$(printf '%s\n' "$scan_line" | grep -oE '[A-Za-z0-9+/_-]{'"$MIN_BLOB_LENGTH"',}={0,3}' 2>/dev/null || true)

    if [[ -z "$blobs" ]]; then
      continue
    fi

    while IFS= read -r blob; do
      if check_base64_blob "$file" "$blob" "$line_num" "$scan_line" "$found"; then
        found=1
      fi
    done <<< "$blobs"
  done < "$file"

  local -a lines=()
  local source_line
  while IFS= read -r source_line || [[ -n "$source_line" ]]; do
    lines+=("$source_line")
  done < "$file"
  local index
  local candidate_blob=""
  local candidate_context=""
  local candidate_line=0
  local candidate_fragments=0
  for ((index = 0; index < ${#lines[@]}; index += 1)); do
    local source_line="${lines[$index]}"
    local scan_line
    local fragments
    scan_line="$source_line"
    fragments="$(extract_quoted_base64_fragments "$scan_line")"

    if [[ -z "$fragments" ]]; then
      candidate_blob=""
      candidate_context=""
      candidate_line=0
      candidate_fragments=0
      continue
    fi

    if [[ $candidate_fragments -eq 0 ]]; then
      candidate_line=$((index + 1))
      candidate_context="$scan_line"
    else
      candidate_context+=$'\n'"$scan_line"
    fi

    local fragment
    while IFS= read -r fragment; do
      [[ -z "$fragment" ]] && continue
      candidate_blob+="$fragment"
      candidate_fragments=$((candidate_fragments + 1))
    done <<< "$fragments"
    if [[ $candidate_fragments -ge 2 ]]; then
      if check_base64_blob "$file" "$candidate_blob" "$candidate_line" "$candidate_context" "$found"; then
        found=1
      fi
    fi
  done

  local -a assignment_fragments=()
  local -a assignment_lines=()
  for ((index = 0; index < ${#lines[@]}; index += 1)); do
    local assignment_line="${lines[$index]}"
    if ! printf '%s\n' "$assignment_line" | grep -qE '(^|[;,][[:space:]]*)((const|let|var)[[:space:]]+)?[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=' 2>/dev/null; then
      continue
    fi
    local assignment_values
    assignment_values="$(extract_quoted_base64_fragments "$assignment_line")"
    fragment="${assignment_values%%$'\n'*}"
    [[ -z "$fragment" ]] && continue
    assignment_fragments+=("$fragment")
    assignment_lines+=("$((index + 1))")
  done

  local start end
  for ((start = 0; start < ${#assignment_fragments[@]}; start += 1)); do
    candidate_blob=""
    for ((end = start; end < ${#assignment_fragments[@]} && end < start + MAX_RECONSTRUCTED_FRAGMENTS; end += 1)); do
      if [[ $((assignment_lines[$end] - assignment_lines[$start])) -gt $MAX_FRAGMENT_GAP_LINES ]]; then
        break
      fi
      candidate_blob+="${assignment_fragments[$end]}"
      [[ ${#candidate_blob} -gt $MAX_RECONSTRUCTED_BLOB_LENGTH ]] && break
      if [[ $end -gt $start ]] && check_base64_blob "$file" "$candidate_blob" "${assignment_lines[$start]}" "base64 assignment fragments" "$found"; then
        found=1
      fi
    done
  done

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
  files_tmp="$(mktemp "${TMPDIR:-/tmp}/base64-scan.XXXXXX")"
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
    if ! extract_and_check_blobs "$file"; then
      failed=$((failed + 1))
    fi
  done < "$files_tmp"
  rm -f "$files_tmp"

  if [[ $seen -eq 0 ]]; then
    echo "base64-scan: no files to scan"
    exit 0
  fi

  echo ""
  echo "base64-scan: scanned $total files, $failed with findings"

  if [[ $failed -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
