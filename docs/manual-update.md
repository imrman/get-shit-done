# Manual Update (Non-npm Install)

Use this procedure when `npx get-shit-done-cc@latest` is unavailable — e.g. during a publish outage or if you are working directly from the source repo.

## Prerequisites

- Node.js installed
- This repo cloned locally (`git clone https://github.com/gsd-build/get-shit-done`)

## Steps

```bash
# 1. Fetch both remotes and create or reuse a sync branch from the hardened branch
git remote add upstream https://github.com/gsd-build/get-shit-done.git 2>/dev/null || true
git fetch origin
git fetch upstream
git switch codex/harden-install-surface
git switch -c sync/upstream-update || git switch sync/upstream-update

# 2. Merge upstream/main into the sync branch and resolve any conflicts there
git merge upstream/main

# 3. Verify the sync branch before installing
git diff --check
node --test tests/hardening-install-surface.test.cjs tests/codex-config.test.cjs tests/install-hooks-copy.test.cjs

# 4. Build the hooks dist (required because hooks/dist/ is generated)
node scripts/build-hooks.js

# 5. Run the installer from the sync branch
node bin/install.js --claude --global

# 6. Clear the update cache so the statusline indicator resets
rm -f ~/.cache/gsd/gsd-update-check.json
```

Open or update a PR from `sync/upstream-update` into `codex/harden-install-surface`, then merge only after the verification above passes.

## Runtime flags

Replace `--claude` with the flag for your runtime:

| Runtime | Flag |
|---|---|
| Claude Code | `--claude` |
| Gemini CLI | `--gemini` |
| OpenCode | `--opencode` |
| Kilo | `--kilo` |
| Codex | `--codex` |
| Copilot | `--copilot` |
| Cursor | `--cursor` |
| Windsurf | `--windsurf` |
| Augment | `--augment` |
| All runtimes | `--all` |

Use `--local` instead of `--global` for a project-scoped install.

## What the installer replaces

The installer performs a clean wipe-and-replace of GSD-managed directories only:

- `~/.claude/get-shit-done/` — workflows, references, templates
- `~/.claude/commands/gsd/` — slash commands
- `~/.claude/agents/gsd-*.md` — GSD agents
- `~/.claude/hooks/dist/` — compiled hooks

**What is preserved:**
- Custom agents not prefixed with `gsd-`
- Custom commands outside `commands/gsd/`
- Your `CLAUDE.md` files
- Custom hooks

Locally modified GSD files are automatically backed up to `gsd-local-patches/` before the install. Run `/gsd-reapply-patches` after updating to merge your modifications back in.
Never pull upstream directly into `codex/harden-install-surface`; always sync through a separate branch and PR.
