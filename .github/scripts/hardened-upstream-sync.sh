#!/usr/bin/env bash
set -euo pipefail

git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || git remote set-url upstream "$UPSTREAM_REPO"
git fetch origin "$BASE_BRANCH" "$SYNC_BRANCH" || git fetch origin "$BASE_BRANCH"
git fetch upstream "$UPSTREAM_REF"

git checkout -B "$SYNC_BRANCH" "origin/$BASE_BRANCH"
before_sha="$(git rev-parse HEAD)"
before_tree="$(git rev-parse "${before_sha}^{tree}")"
upstream_sha="$(git rev-parse "upstream/$UPSTREAM_REF")"

find_open_issue_number() {
  local title="$1"
  if ! gh issue list --state open --search "\"$title\" in:title" --json number,title --jq "map(select(.title == \"$title\")) | .[0].number // empty"; then
    echo "Warning: unable to list GitHub issues; continuing without issue linkage." >&2
  fi
}

upsert_issue_best_effort() {
  local title="$1"
  local body="$2"
  local issue_number=""

  issue_number="$(find_open_issue_number "$title")"
  if [ -n "$issue_number" ]; then
    if ! gh issue edit "$issue_number" --body "$body"; then
      echo "Warning: unable to update GitHub issue #${issue_number}; continuing." >&2
    fi
    printf '%s' "$issue_number"
    return 0
  fi

  if ! gh issue create --title "$title" --body "$body" >/dev/null; then
    echo "Warning: unable to create GitHub issue; continuing without issue linkage." >&2
    return 0
  fi

  find_open_issue_number "$title"
}

cleanup_merge_state() {
  git merge --abort >/dev/null 2>&1 || git reset --hard "$before_sha" >/dev/null 2>&1 || true
}

exclude_workflow_file_changes() {
  local workflow_paths=()
  while IFS= read -r path; do
    case "$path" in
      .github/workflows/*)
        workflow_paths+=("$path")
        ;;
    esac
  done < <(git diff --name-only "$before_sha" HEAD)

  if [ "${#workflow_paths[@]}" -eq 0 ]; then
    return
  fi

  for workflow_path in "${workflow_paths[@]}"; do
    if git cat-file -e "${before_sha}:${workflow_path}" 2>/dev/null; then
      git checkout "$before_sha" -- "$workflow_path"
    else
      rm -f -- "$workflow_path"
      git rm -f --ignore-unmatch -- "$workflow_path" >/dev/null 2>&1 || true
    fi
  done
}

if ! git merge --no-ff --no-edit "upstream/$UPSTREAM_REF"; then
  if ! git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && [ -z "$(git ls-files -u)" ]; then
    echo "Upstream merge failed for a non-conflict reason." >&2
    exit 1
  fi

  issue_title="Upstream sync conflict: ${UPSTREAM_REF} -> ${BASE_BRANCH}"
  issue_body=$(cat <<EOF
Automated upstream sync could not merge \`upstream/${UPSTREAM_REF}\` into \`${BASE_BRANCH}\`.

- Upstream commit: \`${upstream_sha}\`
- Sync branch: \`${SYNC_BRANCH}\`

Resolve the merge conflict manually, then push an updated sync branch PR back into \`${BASE_BRANCH}\`.
EOF
)

  upsert_issue_best_effort "$issue_title" "$issue_body" >/dev/null
  cleanup_merge_state
  echo "Merge conflict encountered; cleaned up merge state."
  exit 0
fi

exclude_workflow_file_changes

after_tree="$(git write-tree)"
if [ "$before_tree" = "$after_tree" ]; then
  git reset --hard "$before_sha" >/dev/null
  echo "No upstream changes to apply."
  exit 0
fi

head_tree="$(git rev-parse HEAD^{tree})"
if [ "$head_tree" != "$after_tree" ]; then
  git commit --amend --no-edit >/dev/null
fi

git push --force-with-lease origin "$SYNC_BRANCH"

issue_title="Upstream sync: ${UPSTREAM_REF} -> ${BASE_BRANCH}"
issue_body=$(cat <<EOF
Track the current automated upstream sync from \`upstream/${UPSTREAM_REF}\` into \`${BASE_BRANCH}\`.

- Upstream commit: \`${upstream_sha}\`
- Candidate branch: \`${SYNC_BRANCH}\`

The linked PR must pass the hardened branch checks before merge.
EOF
)

issue_number="$(upsert_issue_best_effort "$issue_title" "$issue_body")"

pr_title="chore: sync upstream/${UPSTREAM_REF} into ${BASE_BRANCH}"
pr_body=$(cat <<EOF
Automated upstream sync PR.

- Base branch: \`${BASE_BRANCH}\`
- Candidate branch: \`${SYNC_BRANCH}\`
- Upstream commit: \`${upstream_sha}\`
EOF
)

if [ -n "$issue_number" ]; then
  pr_body="${pr_body}

Closes #${issue_number}"
fi

existing_pr="$(gh pr list --state open --base "$BASE_BRANCH" --head "$SYNC_BRANCH" --json number --jq '.[0].number // empty')"
if [ -n "$existing_pr" ]; then
  gh pr edit "$existing_pr" --title "$pr_title" --body "$pr_body"
  if [ "$(gh pr view "$existing_pr" --json isDraft --jq '.isDraft')" = "true" ]; then
    gh pr ready "$existing_pr"
  fi
else
  gh pr create --base "$BASE_BRANCH" --head "$SYNC_BRANCH" --title "$pr_title" --body "$pr_body"
fi
