#!/usr/bin/env bash
# prompt-injection-scan.sh — Scan files for prompt injection patterns
#
# Usage:
#   scripts/prompt-injection-scan.sh --diff origin/main   # CI mode: scan changed .md files
#   scripts/prompt-injection-scan.sh --file path/to/file   # Scan a single file
#   scripts/prompt-injection-scan.sh --dir agents/          # Scan all files in a directory
#
# Exit codes:
#   0 = clean
#   1 = findings detected
#   2 = usage error
set -euo pipefail

# ─── Patterns ────────────────────────────────────────────────────────────────
# Each pattern is a POSIX extended regex. Keep alphabetized by category.

PATTERNS=(
  # Instruction override
  'ignore[[:space:]]+(all[[:space:]]+)?(previous|prior|above|earlier|preceding)[[:space:]]+(instructions|prompts|rules|directives|context)'
  'disregard[[:space:]]+(all[[:space:]]+)?(previous|prior|above)[[:space:]]+(instructions|prompts|rules)'
  'forget[[:space:]]+(all[[:space:]]+)?(previous|prior|above)[[:space:]]+(instructions|prompts|rules|context)'
  'override[[:space:]]+(all[[:space:]]+)?(system|previous|safety)[[:space:]]+(instructions|prompts|rules|checks|filters|guards)'
  'override[[:space:]]+(system|safety|security)[[:space:]]'

  # Role manipulation
  'you[[:space:]]+are[[:space:]]+now[[:space:]]+(a|an|my)[[:space:]]'
  'from[[:space:]]+now[[:space:]]+on[[:space:]]+(you|pretend|act|behave)'
  'pretend[[:space:]]+(you[[:space:]]+are|to[[:space:]]+be)[[:space:]]'
  'act[[:space:]]+as[[:space:]]+(a|an|if|my)[[:space:]]'
  'roleplay[[:space:]]+as[[:space:]]'
  'assume[[:space:]]+the[[:space:]]+role[[:space:]]+of[[:space:]]'

  # System prompt extraction
  'output[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'reveal[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'show[[:space:]]+me[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'print[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'what[[:space:]]+(is|are)[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'repeat[[:space:]]+(your|the|all)[[:space:]]+(system[[:space:]]+)?(prompt|instructions|rules)'

  # Fake message boundaries
  '</?system>'
  '</?assistant>'
  '</?human>'
  '\[SYSTEM\]'
  '\[/SYSTEM\]'
  '\[INST\]'
  '\[/INST\]'
  '<<SYS>>'
  '<</SYS>>'

  # Tool call injection / code execution in markdown
  'eval[[:space:]]*\([[:space:]]*["\x27]'
  'exec[[:space:]]*\([[:space:]]*["\x27]'
  'Function[[:space:]]*\([[:space:]]*["\x27].*return'

  # Jailbreak / DAN patterns
  'do[[:space:]]+anything[[:space:]]+now'
  'DAN[[:space:]]+mode'
  'developer[[:space:]]+mode[[:space:]]+(enabled|output|activated)'
  'jailbreak'
  'bypass[[:space:]]+(safety|content|security)[[:space:]]+(filter|check|rule|guard)'
)

COMBINED_PATTERN=""
for pattern in "${PATTERNS[@]}"; do
  if [[ -z "$COMBINED_PATTERN" ]]; then
    COMBINED_PATTERN="($pattern)"
  else
    COMBINED_PATTERN+="|($pattern)"
  fi
done

has_invisible_unicode() {
  perl -CSDA -e 'my $found = 0; while (<>) { $found ||= /[\x{00AD}\x{200B}-\x{200F}\x{2028}-\x{202F}\x{2060}-\x{2069}\x{FEFF}]/; } exit($found ? 0 : 1)' -- "$1"
}

normalize_invisible_unicode() {
  perl -CSDA -pe 's/[\x{00AD}\x{200B}-\x{200F}\x{2028}-\x{202F}\x{2060}-\x{2069}\x{FEFF}]/ /g'
}

# ─── Allowlist ───────────────────────────────────────────────────────────────
# Files that legitimately discuss injection patterns (security docs, tests, this script)
ALLOWLIST=(
  'scripts/prompt-injection-scan.sh'
  'scripts/base64-scan.sh'
  'scripts/base64-scan.cjs'
  'scripts/secret-scan.sh'
  'tests/security-scan.test.cjs'
  'tests/security.test.cjs'
  'tests/prompt-injection-scan.test.cjs'
  'tests/verify.test.cjs'
  'get-shit-done/bin/lib/security.cjs'
  'hooks/gsd-prompt-guard.js'
  'hooks/gsd-read-injection-scanner.js'
  'tests/read-injection-scanner.test.cjs'
  'SECURITY.md'
)

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

is_allowlisted() {
  local file
  local mode="${2:-}"
  file="$(normalize_repo_path "$1")"
  if [[ "$mode" == "--diff" ]]; then
    return 1
  fi
  for allowed in "${ALLOWLIST[@]}"; do
    if [[ "$file" == "$allowed" ]]; then
      return 0
    fi
  done
  return 1
}

is_allowed_match() {
  local file="$1"
  local line_text="$2"
  file="$(normalize_repo_path "$file")"

  if [[ "$file" == "scripts/base64-scan.cjs" ]]; then
    [[ "$line_text" == 'const patterns = [/<<SYS>>/i, /jailbreak/i];' ]] && return 0
    [[ "$line_text" =~ ^[[:space:]]*/.*(/[dgimsuvy]*),?[[:space:]]*$ ]] && return 0
  fi

  if [[ "$file" == "scripts/base64-scan.sh" || "$file" == "scripts/prompt-injection-scan.sh" ]]; then
    printf '%s\n' "$line_text" | grep -qE "^[[:space:]]*'.*'[[:space:]]*$" && return 0
  fi

  if [[ "$file" == "scripts/prompt-injection-scan.sh" ]]; then
    [[ "$line_text" == '  # Jailbreak / DAN patterns' ]] && return 0
    [[ "$line_text" == *'[[ "$line_text"'* ]] && return 0
  fi

  if [[ "$file" == "tests/read-injection-scanner.test.cjs" ]]; then
    [[ "$line_text" == *'runHook(readPayload('* ]] && return 0
    [[ "$line_text" == *'readPayload('* ]] && return 0
    [[ "$line_text" == *'tool_response:'* ]] && return 0
    [[ "$line_text" == *"{ type: 'text', text:"* ]] && return 0
    [[ "$line_text" == *'fs.writeFileSync('* ]] && return 0
    printf '%s\n' "$line_text" | grep -qE "^[[:space:]]*['\"\`].*['\"\`][,);]*[[:space:]]*$" && return 0
  fi

  if [[ "$file" == "tests/security-scan.test.cjs" ]]; then
    [[ "$line_text" == *'runScript('* ]] && return 0
    [[ "$line_text" == *'runScriptAtRelativePath('* ]] && return 0
    [[ "$line_text" == *'runScriptWith'* ]] && return 0
    [[ "$line_text" == *'writeFile('* ]] && return 0
    [[ "$line_text" == *'fs.writeFileSync('* ]] && return 0
    [[ "$line_text" == *'toBase64('* ]] && return 0
    [[ "$line_text" == *'toBase64Url('* ]] && return 0
    [[ "$line_text" == *"test('detects"* ]] && return 0
    [[ "$line_text" == *'const decodedPayload ='* ]] && return 0
    printf '%s\n' "$line_text" | grep -qE "^[[:space:]]*['\"\`].*['\"\`][,);]*[[:space:]]*$" && return 0
  fi

  if [[ "$file" == "sdk/src/query/commit.ts" ]]; then
    [[ "$line_text" == *'Neutralize [SYSTEM] / [INST] markers'* ]] && return 0
    [[ "$line_text" == *'sanitized = sanitized.replace(/\[(SYSTEM|INST)\]/gi,'* ]] && return 0
    [[ "$line_text" == *"sanitized = sanitized.replace(/\\[(SYSTEM|INST)\\]/gi, '["* ]] && return 0
    [[ "$line_text" == *'Neutralize <<SYS>> markers'* ]] && return 0
    [[ "$line_text" == *'sanitized = sanitized.replace(/<<\s*SYS\s*>>/gi,'* ]] && return 0
  fi

  if [[ "$file" == "sdk/src/query/commit.test.ts" ]]; then
    [[ "$line_text" == *"sanitizeCommitMessage('fix: update <system> prompt [SYSTEM] test')"* ]] && return 0
    [[ "$line_text" == *"expect(result).not.toContain('<system>')"* ]] && return 0
    [[ "$line_text" == *"expect(result).not.toContain('[SYSTEM]')"* ]] && return 0
  fi

  return 1
}

is_allowed_window() {
  local file="$1"
  shift
  local line
  local matched_allowed=0
  for line in "$@"; do
    if ! printf '%s\n' "$line" | grep -iqE -e "$COMBINED_PATTERN" 2>/dev/null; then
      continue
    fi
    if is_allowed_match "$file" "$line"; then
      matched_allowed=1
    else
      return 1
    fi
  done
  [[ $matched_allowed -eq 1 ]]
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
    *.md|*.cjs|*.js|*.mjs|*.ts|*.tsx|*.mts|*.json|*.yml|*.yaml|*.sh) return 0 ;;
    *) return 1 ;;
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
  paths_tmp="$(mktemp "${TMPDIR:-/tmp}/prompt-injection-scan-paths.XXXXXX")"
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
      find "$dir" -type f \( -name '*.md' -o -name '*.cjs' -o -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' -o -name '*.sh' \) \
        ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/dist/*' -print0 2>/dev/null || true
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

scan_file() {
  local file="$1"
  local mode="${2:-}"
  local found=0
  local normalized_content=""
  local invisible_normalized_content=""

  if is_allowlisted "$file" "$mode"; then
    return 0
  fi

  local matches
  matches=$(grep -inE -e "$COMBINED_PATTERN" -- "$file" 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    while IFS= read -r line; do
      local line_num="${line%%:*}"
      local line_text="${line#*:}"
      if is_allowed_match "$file" "$line_text"; then
        continue
      fi
      if [[ $found -eq 0 ]]; then
        echo "FAIL: $(sanitize_file_id "$file")"
        found=1
      fi
      echo "  line $line_num: matched pattern"
      echo "    pattern: prompt injection pattern"
    done <<< "$matches"
  fi

  if has_invisible_unicode "$file"; then
    if [[ $found -eq 0 ]]; then
      echo "FAIL: $(sanitize_file_id "$file")"
      found=1
    fi
    echo "  invisible Unicode characters detected"
  fi

  normalized_content="$(tr '\r\n\t' '   ' < "$file")"
  invisible_normalized_content="$(printf '%s\n' "$normalized_content" | normalize_invisible_unicode)"
  if printf '%s\n' "$invisible_normalized_content" | grep -iqE -e "$COMBINED_PATTERN" 2>/dev/null &&
    ! printf '%s\n' "$normalized_content" | grep -iqE -e "$COMBINED_PATTERN" 2>/dev/null; then
    if [[ $found -eq 0 ]]; then
      echo "FAIL: $(sanitize_file_id "$file")"
      found=1
    fi
    echo "  line 1: matched pattern after invisible Unicode normalization"
    echo "    pattern: prompt injection pattern"
  fi
  if printf '%s\n' "$normalized_content" | grep -iqE -e "$COMBINED_PATTERN" 2>/dev/null; then
    local -a file_lines=()
    local -a unallowed_lines=()
    local source_line
    while IFS= read -r source_line || [[ -n "$source_line" ]]; do
      file_lines+=("$source_line")
      if ! is_allowed_match "$file" "$source_line"; then
        unallowed_lines+=("$source_line")
      fi
    done < "$file"
    if [[ ${#file_lines[@]} -gt 1 ]]; then

      local index
      local matched_window=0
      for ((index = 0; index < ${#file_lines[@]} - 1; index += 1)); do
        local window="${file_lines[$index]} ${file_lines[$((index + 1))]}"
        if printf '%s\n' "$window" | grep -iqE -e "$COMBINED_PATTERN" 2>/dev/null; then
          if is_allowed_window "$file" "${file_lines[$index]}" "${file_lines[$((index + 1))]}"; then
            continue
          fi
          if [[ $found -eq 0 ]]; then
            echo "FAIL: $(sanitize_file_id "$file")"
            found=1
          fi
          echo "  line $((index + 1)): matched pattern across lines"
          echo "    pattern: prompt injection pattern"
          matched_window=1
          break
        fi
      done
      if [[ $matched_window -eq 0 && ${#file_lines[@]} -gt 2 ]]; then
        for ((index = 0; index < ${#file_lines[@]} - 2; index += 1)); do
          local window="${file_lines[$index]} ${file_lines[$((index + 1))]} ${file_lines[$((index + 2))]}"
          if printf '%s\n' "$window" | grep -iqE -e "$COMBINED_PATTERN" 2>/dev/null; then
            if is_allowed_window "$file" "${file_lines[$index]}" "${file_lines[$((index + 1))]}" "${file_lines[$((index + 2))]}"; then
              continue
            fi
            if [[ $found -eq 0 ]]; then
              echo "FAIL: $(sanitize_file_id "$file")"
              found=1
            fi
            echo "  line $((index + 1)): matched pattern across lines"
            echo "    pattern: prompt injection pattern"
            break
          fi
        done
      fi
    fi
    if [[ $found -eq 0 && ${#unallowed_lines[@]} -gt 0 ]]; then
      local unallowed_normalized_content
      unallowed_normalized_content="$(printf '%s\n' "${unallowed_lines[@]}" | tr '\r\n\t' '   ')"
      if printf '%s\n' "$unallowed_normalized_content" | grep -iqE -e "$COMBINED_PATTERN" 2>/dev/null; then
        echo "FAIL: $(sanitize_file_id "$file")"
        echo "  line 1: matched pattern across multiple lines"
        echo "    pattern: prompt injection pattern"
        found=1
      fi
    fi
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

  local files_tmp
  files_tmp="$(mktemp "${TMPDIR:-/tmp}/prompt-injection-scan.XXXXXX")"
  collect_files "$mode" "$@" > "$files_tmp"

  local seen=0
  local total=0
  local failed=0

  while IFS= read -r -d '' file; do
    seen=1
    total=$((total + 1))
    if ! scan_file "$file" "$mode"; then
      failed=$((failed + 1))
    fi
  done < "$files_tmp"
  rm -f "$files_tmp"

  if [[ $seen -eq 0 ]]; then
    echo "prompt-injection-scan: no files to scan"
    exit 0
  fi

  echo ""
  echo "prompt-injection-scan: scanned $total files, $failed with findings"

  if [[ $failed -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
