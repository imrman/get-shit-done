#!/usr/bin/env bash
set -euo pipefail

git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || git remote set-url upstream "$UPSTREAM_REPO"
git fetch origin "$BASE_BRANCH" "$SYNC_BRANCH" || git fetch origin "$BASE_BRANCH"
git fetch upstream "$UPSTREAM_REF"

git checkout -B "$SYNC_BRANCH" "origin/$BASE_BRANCH"
before_sha="$(git rev-parse HEAD)"
upstream_sha="$(git rev-parse "upstream/$UPSTREAM_REF")"

find_open_issue_number() {
  local title="$1"
  gh issue list --state open --search "\"$title\" in:title" --json number,title --jq "map(select(.title == \"$title\")) | .[0].number // empty"
}

if ! git merge --no-ff --no-edit "upstream/$UPSTREAM_REF"; then
  issue_title="Upstream sync conflict: ${UPSTREAM_REF} -> ${BASE_BRANCH}"
  issue_number="$(find_open_issue_number "$issue_title")"
  issue_body=$(cat <<EOF
Automated upstream sync could not merge \`upstream/${UPSTREAM_REF}\` into \`${BASE_BRANCH}\`.

- Upstream commit: \`${upstream_sha}\`
- Sync branch: \`${SYNC_BRANCH}\`

Resolve the merge conflict manually, then push an updated sync branch PR back into \`${BASE_BRANCH}\`.
EOF
)

  if [ -n "$issue_number" ]; then
    gh issue edit "$issue_number" --body "$issue_body"
  else
    gh issue create --title "$issue_title" --body "$issue_body"
  fi
  exit 1
fi

after_sha="$(git rev-parse HEAD)"
if [ "$before_sha" = "$after_sha" ]; then
  echo "No upstream changes to apply."
  exit 0
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

issue_number="$(find_open_issue_number "$issue_title")"
if [ -n "$issue_number" ]; then
  gh issue edit "$issue_number" --body "$issue_body"
else
  gh issue create --title "$issue_title" --body "$issue_body" >/dev/null
  issue_number="$(find_open_issue_number "$issue_title")"
fi

pr_title="chore: sync upstream/${UPSTREAM_REF} into ${BASE_BRANCH}"
pr_body=$(cat <<EOF
Automated upstream sync PR.

- Base branch: \`${BASE_BRANCH}\`
- Candidate branch: \`${SYNC_BRANCH}\`
- Upstream commit: \`${upstream_sha}\`

Closes #${issue_number}
EOF
)

existing_pr="$(gh pr list --state open --base "$BASE_BRANCH" --head "$SYNC_BRANCH" --json number --jq '.[0].number // empty')"
if [ -n "$existing_pr" ]; then
  gh pr edit "$existing_pr" --title "$pr_title" --body "$pr_body"
  if [ "$(gh pr view "$existing_pr" --json isDraft --jq '.isDraft')" = "true" ]; then
    gh pr ready "$existing_pr"
  fi
else
  gh pr create --base "$BASE_BRANCH" --head "$SYNC_BRANCH" --title "$pr_title" --body "$pr_body"
fi
