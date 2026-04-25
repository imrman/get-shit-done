const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, '.github', 'scripts', 'hardened-upstream-sync.sh');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function createTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(args, cwd, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

function gitShell(command, cwd, env = {}) {
  execSync(command, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...env },
  });
}

function writeFile(repoDir, relPath, content) {
  const absPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function configureRepo(repoDir) {
  git(['config', 'user.name', 'Test User'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
}

function createBareRepo(parentDir, name) {
  const repoPath = path.join(parentDir, name);
  git(['init', '--bare', repoPath], parentDir);
  return repoPath;
}

function toBashPath(repoPath) {
  const normalized = repoPath.replace(/\\/g, '/');
  if (!/^[A-Za-z]:\//.test(normalized)) {
    return normalized;
  }
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

function cloneRepo(source, targetDir) {
  git(['clone', source, targetDir], ROOT);
  return targetDir;
}

function installGhStub(binDir, options = {}) {
  const ghPath = path.join(binDir, 'gh');
  const prCreateBodyPath = path.join(binDir, 'gh-pr-create-body.txt');
  const prCreateBodyBashPath = toBashPath(prCreateBodyPath);
  const defaults = {
    issueCreateStatus: 0,
    issueCreateStderr: '',
    issueCreateStdout: '',
    issueEditStatus: 0,
    issueEditStderr: '',
    issueEditStdout: '',
    issueListStatus: 0,
    issueListStderr: '',
    issueListStdout: '',
    prCreateStatus: 0,
    prCreateStderr: '',
    prCreateStdout: '',
    prEditStatus: 0,
    prEditStderr: '',
    prEditStdout: '',
    prListStatus: 0,
    prListStderr: '',
    prListStdout: '',
    prReadyStatus: 0,
    prReadyStderr: '',
    prReadyStdout: '',
    prViewStatus: 0,
    prViewStderr: '',
    prViewStdout: 'false',
  };
  const config = { ...defaults, ...options };
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
pr_create_body_path=${shQuote(prCreateBodyBashPath)}

write_output() {
  local stdout_content="$1"
  local stderr_content="$2"
  local status_code="$3"

  if [ -n "$stdout_content" ]; then
    printf '%s' "$stdout_content"
  fi

  if [ -n "$stderr_content" ]; then
    printf '%s\\n' "$stderr_content" >&2
  fi

  exit "$status_code"
}

find_arg_value() {
  local flag="$1"
  shift

  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$flag" ] && [ "$#" -ge 2 ]; then
      printf '%s' "$2"
      return 0
    fi
    shift
  done

  return 1
}

case "$1 $2" in
  "issue list")
    write_output ${shQuote(config.issueListStdout)} ${shQuote(config.issueListStderr)} ${config.issueListStatus}
    ;;
  "issue create")
    write_output ${shQuote(config.issueCreateStdout)} ${shQuote(config.issueCreateStderr)} ${config.issueCreateStatus}
    ;;
  "issue edit")
    write_output ${shQuote(config.issueEditStdout)} ${shQuote(config.issueEditStderr)} ${config.issueEditStatus}
    ;;
  "pr list")
    write_output ${shQuote(config.prListStdout)} ${shQuote(config.prListStderr)} ${config.prListStatus}
    ;;
  "pr create")
    if body="$(find_arg_value --body "$@" 2>/dev/null)"; then
      printf '%s' "$body" > "$pr_create_body_path"
    fi
    write_output ${shQuote(config.prCreateStdout)} ${shQuote(config.prCreateStderr)} ${config.prCreateStatus}
    ;;
  "pr edit")
    write_output ${shQuote(config.prEditStdout)} ${shQuote(config.prEditStderr)} ${config.prEditStatus}
    ;;
  "pr ready")
    write_output ${shQuote(config.prReadyStdout)} ${shQuote(config.prReadyStderr)} ${config.prReadyStatus}
    ;;
  "pr view")
    write_output ${shQuote(config.prViewStdout)} ${shQuote(config.prViewStderr)} ${config.prViewStatus}
    ;;
  *)
    exit 0
    ;;
esac
`,
    { mode: 0o755 }
  );
  return { ghPath, prCreateBodyPath };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function setupSyncRepos({ ghOptions, originReadme, originWorkflow, upstreamReadme, upstreamWorkflow }) {
  const sandbox = createTempDir('hardened-upstream-sync-');
  const seed = path.join(sandbox, 'seed');
  const runner = path.join(sandbox, 'runner');
  const upstreamWork = path.join(sandbox, 'upstream-work');
  const originBare = createBareRepo(sandbox, 'origin.git');
  const upstreamBare = createBareRepo(sandbox, 'upstream.git');

  git(['init', '-b', 'main', seed], sandbox);
  configureRepo(seed);
  writeFile(seed, 'README.md', 'base readme\n');
  writeFile(seed, '.github/workflows/test.yml', 'name: original\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'initial'], seed);
  git(['remote', 'add', 'origin', originBare], seed);
  git(['remote', 'add', 'upstream', upstreamBare], seed);
  git(['push', 'origin', 'main'], seed);
  git(['push', 'upstream', 'main'], seed);

  if (originReadme !== undefined) {
    writeFile(seed, 'README.md', originReadme);
  }
  if (originWorkflow !== undefined) {
    writeFile(seed, '.github/workflows/test.yml', originWorkflow);
  }
  if (originReadme !== undefined || originWorkflow !== undefined) {
    git(['add', '.'], seed);
    git(['commit', '-m', 'origin change'], seed);
    git(['push', 'origin', 'main'], seed);
  }

  cloneRepo(originBare, runner);
  configureRepo(runner);
  git(['checkout', 'main'], runner);
  git(['remote', 'set-url', 'origin', toBashPath(originBare)], runner);

  cloneRepo(upstreamBare, upstreamWork);
  configureRepo(upstreamWork);
  git(['checkout', 'main'], upstreamWork);
  if (upstreamReadme !== undefined) {
    writeFile(upstreamWork, 'README.md', upstreamReadme);
  }
  if (upstreamWorkflow !== undefined) {
    writeFile(upstreamWork, '.github/workflows/test.yml', upstreamWorkflow);
  }
  git(['add', '.'], upstreamWork);
  git(['commit', '-m', 'upstream change'], upstreamWork);
  git(['push', 'origin', 'main'], upstreamWork);

  const binDir = path.join(runner, '.test-bin');
  const ghStub = installGhStub(binDir, ghOptions);

  return {
    binDir,
    ghStub,
    originBare,
    runner,
    sandbox,
    syncBranch: 'chore/upstream-sync-main',
    upstreamBare,
    upstreamRepoUrl: toBashPath(upstreamBare),
  };
}

function runSyncScript({ runner, binDir, upstreamRepoUrl, syncBranch }) {
  const runnerScriptPath = path.join(runner, '.github', 'scripts', 'hardened-upstream-sync.sh');
  fs.mkdirSync(path.dirname(runnerScriptPath), { recursive: true });
  fs.copyFileSync(SCRIPT_PATH, runnerScriptPath);

  const command = [
    'PATH="./.test-bin:$PATH"',
    `BASE_BRANCH=${shQuote('main')}`,
    `SYNC_BRANCH=${shQuote(syncBranch)}`,
    `UPSTREAM_REPO=${shQuote(upstreamRepoUrl)}`,
    `UPSTREAM_REF=${shQuote('main')}`,
    `GH_TOKEN=${shQuote('test-token')}`,
    'bash ./.github/scripts/hardened-upstream-sync.sh',
  ].join(' ');

  return spawnSync('bash', ['-lc', command], {
    cwd: runner,
    encoding: 'utf8',
    env: process.env,
  });
}

function showFileFromBareRepo(repoPath, ref, filePath) {
  return git(['--git-dir', repoPath, 'show', `${ref}:${filePath}`], ROOT);
}

function listBareRepoHeads(repoPath) {
  return git(
    ['--git-dir', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    ROOT
  ).split(/\r?\n/).filter(Boolean);
}

describe('hardened upstream sync', () => {
  test('leaves native POSIX paths unchanged for bash execution', () => {
    assert.equal(toBashPath('/tmp/hardened-upstream-sync-origin.git'), '/tmp/hardened-upstream-sync-origin.git');
  });

  test('excludes workflow file changes while keeping other upstream changes', () => {
    const fixture = setupSyncRepos({
      upstreamReadme: 'upstream readme\n',
      upstreamWorkflow: 'name: upstream\n',
    });

    const result = runSyncScript(fixture);

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const readme = showFileFromBareRepo(
      fixture.originBare,
      fixture.syncBranch,
      'README.md'
    );
    const workflow = showFileFromBareRepo(
      fixture.originBare,
      fixture.syncBranch,
      '.github/workflows/test.yml'
    );

    assert.equal(readme, 'upstream readme');
    assert.equal(workflow, 'name: original');
  });

  test('skips creating a sync branch when upstream only changes workflow files', () => {
    const fixture = setupSyncRepos({
      upstreamWorkflow: 'name: upstream-only\n',
    });

    const result = runSyncScript(fixture);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /No upstream changes to apply\./);

    assert.deepEqual(listBareRepoHeads(fixture.originBare), ['main']);
  });

  test('treats merge conflicts as handled, cleans merge state, and does not push a sync branch', () => {
    const fixture = setupSyncRepos({
      ghOptions: {
        issueCreateStatus: 1,
        issueCreateStderr: 'HTTP 403: issues are disabled',
        issueListStatus: 1,
        issueListStderr: 'HTTP 403: issues are disabled',
      },
      originReadme: 'origin readme\n',
      upstreamReadme: 'upstream readme\n',
    });

    const result = runSyncScript(fixture);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Merge conflict encountered; cleaned up merge state\./);
    assert.deepEqual(listBareRepoHeads(fixture.originBare), ['main']);
    assert.equal(fs.existsSync(path.join(fixture.runner, '.git', 'MERGE_HEAD')), false);
    assert.equal(git(['status', '--short', '--untracked-files=no'], fixture.runner), '');
  });

  test('keeps a successful sync best-effort when issue permissions are denied and omits Closes from the PR body', () => {
    const fixture = setupSyncRepos({
      ghOptions: {
        issueCreateStatus: 1,
        issueCreateStderr: 'HTTP 403: issues are disabled',
        issueListStatus: 1,
        issueListStderr: 'HTTP 403: issues are disabled',
      },
      upstreamReadme: 'upstream readme\n',
    });

    const result = runSyncScript(fixture);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(listBareRepoHeads(fixture.originBare).sort(), [fixture.syncBranch, 'main'].sort());
    assert.equal(fs.readFileSync(fixture.ghStub.prCreateBodyPath, 'utf8').includes('Closes #'), false);
  });
});
