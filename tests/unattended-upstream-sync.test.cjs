// allow-test-rule: shell-script-integration-harness-asserts-process-log-contracts
const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'unattended-upstream-sync.sh');

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

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFile(repoDir, relPath, content, mode) {
  const absPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, mode ? { mode } : undefined);
}

function configureRepo(repoDir) {
  git(['config', 'user.name', 'Test User'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
}

function commitAll(repoDir, message) {
  git(['add', '.'], repoDir);
  git(['commit', '-m', message], repoDir);
}

function createBareRepo(parentDir, name) {
  const repoPath = path.join(parentDir, name);
  git(['init', '--bare', repoPath], parentDir);
  return repoPath;
}

function createScanner(name, exitCode = 0) {
  return `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\\n' ${JSON.stringify(name)} "$*" >> "$VALIDATION_LOG"
exit ${exitCode}
`;
}

function createInstallScript() {
  return `#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const expected = ['--codex', '--global', '--no-sdk'];
for (const arg of expected) {
  if (!process.argv.includes(arg)) {
    console.error('missing installer arg: ' + arg);
    process.exit(9);
  }
}

fs.appendFileSync(process.env.INSTALL_LOG, process.argv.slice(2).join(' ') + '\\n');
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
for (const skill of ['gsd-alpha', 'gsd-beta']) {
  const dir = path.join(codexHome, 'skills', skill);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\\nname: ' + skill + '\\n---\\n');
}
const gsdDir = path.join(codexHome, 'get-shit-done');
fs.mkdirSync(gsdDir, { recursive: true });
fs.writeFileSync(path.join(gsdDir, 'VERSION'), require('../package.json').version + '\\n');
fs.writeFileSync(path.join(codexHome, 'gsd-file-manifest.json'), JSON.stringify({ version: require('../package.json').version, files: {} }));
`;
}

function writeFakeProject(repoDir, { testExit = 0, testOutput = '' } = {}) {
  const scanExit = testExit === 0 ? 0 : testExit;
  writeFile(repoDir, 'README.md', 'base readme\n');
  writeFile(repoDir, 'SECURITY.md', 'origin hardened security\n');
  writeFile(repoDir, '.github/workflows/hardened.yml', 'name: origin hardened workflow\n');
  writeFile(repoDir, '.github/CODEOWNERS', '* @origin-owner\n');
  writeFile(repoDir, 'scripts/secret-scan.sh', createScanner('secret', scanExit), 0o755);
  writeFile(repoDir, 'scripts/prompt-injection-scan.sh', createScanner('prompt', scanExit), 0o755);
  writeFile(repoDir, 'scripts/base64-scan.sh', createScanner('base64', scanExit), 0o755);
  writeFile(
    repoDir,
    'scripts/test-runner.js',
    `require('fs').appendFileSync(process.env.VALIDATION_LOG, 'npm test\\n'); process.stdout.write(${JSON.stringify(testOutput)}); process.exit(${testExit});\n`
  );
  writeFile(
    repoDir,
    'package.json',
    JSON.stringify({ version: '9.9.9', scripts: { test: 'node scripts/test-runner.js' } }, null, 2) + '\n'
  );
  writeFile(repoDir, 'bin/install.js', createInstallScript(), 0o755);
}

function setupRepos({ testExit = 0, testOutput = '' } = {}) {
  const sandbox = createTempDir('unattended-upstream-sync-');
  const originBare = createBareRepo(sandbox, 'origin.git');
  const upstreamBare = createBareRepo(sandbox, 'upstream.git');
  const seed = path.join(sandbox, 'seed');
  const runner = path.join(sandbox, 'runner');
  const upstreamWork = path.join(sandbox, 'upstream-work');
  const validationLog = path.join(sandbox, 'validation.log');
  const installLog = path.join(sandbox, 'install.log');
  const home = path.join(sandbox, 'home');
  const codexHome = path.join(home, '.codex');

  git(['init', '-b', 'main', seed], sandbox);
  configureRepo(seed);
  writeFakeProject(seed, { testExit, testOutput });
  commitAll(seed, 'initial');
  git(['remote', 'add', 'origin', originBare], seed);
  git(['remote', 'add', 'upstream', upstreamBare], seed);
  git(['push', 'origin', 'main'], seed);
  git(['push', 'upstream', 'main'], seed);
  git(['--git-dir', originBare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], sandbox);
  git(['--git-dir', upstreamBare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], sandbox);
  git(['--git-dir', originBare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], sandbox);
  git(['--git-dir', upstreamBare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], sandbox);

  git(['clone', originBare, runner], sandbox);
  configureRepo(runner);

  git(['clone', upstreamBare, upstreamWork], sandbox);
  configureRepo(upstreamWork);
  writeFile(upstreamWork, 'README.md', 'upstream readme\n');
  writeFile(upstreamWork, 'SECURITY.md', 'upstream security should not win\n');
  writeFile(upstreamWork, '.github/workflows/canary.yml', 'name: upstream workflow should not win\n');
  writeFile(upstreamWork, 'scripts/secret-scan.sh', '#!/usr/bin/env bash\necho upstream secret scan\n', 0o755);
  commitAll(upstreamWork, 'upstream change');
  git(['push', 'origin', 'HEAD:main'], upstreamWork);

  return { codexHome, home, installLog, originBare, runner, upstreamBare, upstreamWork, validationLog };
}

function runScript(fixture, extraArgs = [], extraEnv = {}) {
  return spawnSync('bash', [
    SCRIPT_PATH,
    '--repo', fixture.runner,
    '--upstream-url', fixture.upstreamBare,
    '--work-root', path.join(path.dirname(fixture.runner), 'worktrees'),
    '--lock-file', path.join(path.dirname(fixture.runner), 'sync.lock'),
    '--log-dir', path.join(path.dirname(fixture.runner), 'logs'),
    ...extraArgs,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      HOME: fixture.home,
      GSD_SYNC_MIN_SKILLS: '2',
      INSTALL_LOG: fixture.installLog,
      VALIDATION_LOG: fixture.validationLog,
      ...extraEnv,
    },
  });
}

function showFromBare(repoPath, ref, filePath) {
  return git(['--git-dir', repoPath, 'show', `${ref}:${filePath}`], ROOT);
}

function existsInBare(repoPath, ref, filePath) {
  try {
    git(['--git-dir', repoPath, 'cat-file', '-e', `${ref}:${filePath}`], ROOT);
    return true;
  } catch {
    return false;
  }
}

describe('unattended upstream sync script', () => {
  test('syncs upstream changes, preserves hardened fork files, validates, pushes, and installs Codex skills', () => {
    const fixture = setupRepos();

    const result = runScript(fixture);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'upstream readme');
    assert.equal(showFromBare(fixture.originBare, 'main', 'SECURITY.md'), 'origin hardened security');
    assert.equal(showFromBare(fixture.originBare, 'main', 'scripts/secret-scan.sh'), createScanner('secret').trim());
    assert.equal(existsInBare(fixture.originBare, 'main', '.github/workflows/canary.yml'), false);
    assert.match(fs.readFileSync(fixture.validationLog, 'utf8'), /npm test/);
    assert.match(fs.readFileSync(fixture.validationLog, 'utf8'), /prompt --diff [0-9a-f]{40}/);
    assert.match(fs.readFileSync(fixture.validationLog, 'utf8'), /base64 --diff [0-9a-f]{40}/);
    assert.match(fs.readFileSync(fixture.validationLog, 'utf8'), /secret --diff [0-9a-f]{40}/);
    assert.deepEqual(
      fs.readFileSync(fixture.installLog, 'utf8').trim().split(/\r?\n/),
      ['--codex --global --no-sdk', '--codex --global --no-sdk']
    );
    assert.equal(fs.readdirSync(path.join(fixture.codexHome, 'skills')).filter(name => name.startsWith('gsd-')).length, 2);
    assert.match(fs.readFileSync(path.join(fixture.codexHome, 'get-shit-done', 'SOURCE'), 'utf8'), /commit=/);
    assert.equal(fs.readFileSync(path.join(fixture.codexHome, 'get-shit-done', 'VERSION'), 'utf8').trim(), '9.9.9');
  });

  test('dry-run validates the candidate but skips push and install', () => {
    const fixture = setupRepos();

    const result = runScript(fixture, ['--dry-run']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Dry run enabled/);
    assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'base readme');
    assert.match(fs.readFileSync(fixture.validationLog, 'utf8'), /npm test/);
    assert.equal(fs.existsSync(fixture.installLog), false);
  });

  test('validation failure blocks main promotion, push, and install', () => {
    const fixture = setupRepos({ testExit: 7 });

    const result = runScript(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Validation failed/);
    assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'base readme');
    assert.equal(fs.existsSync(fixture.installLog), false);
  });

  test('reported npm test failures block promotion even when test runner exits zero', () => {
    const fixture = setupRepos({ testOutput: 'ℹ tests 12\nℹ pass 10\nℹ fail 2\n\n✖ failing tests:\n' });

    const result = runScript(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /npm test reported failing tests despite exit status 0/);
    assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'base readme');
    assert.equal(fs.existsSync(fixture.installLog), false);
  });

  test('dirty checked-out main does not block remote push or Codex install', () => {
    const fixture = setupRepos();
    writeFile(fixture.runner, 'local-notes.txt', 'local uncommitted file\n');

    const result = runScript(fixture);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /leaving local checkout untouched/);
    assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'upstream readme');
    assert.equal(git(['show', 'HEAD:README.md'], fixture.runner), 'base readme');
    assert.equal(fs.existsSync(path.join(fixture.codexHome, 'get-shit-done', 'VERSION')), true);
  });

  test('skip-install promotes and pushes validated source without touching Codex home', () => {
    const fixture = setupRepos();

    const result = runScript(fixture, ['--skip-install']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Skip install enabled/);
    assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'upstream readme');
    assert.equal(fs.existsSync(fixture.installLog), false);
    assert.equal(fs.existsSync(path.join(fixture.codexHome, 'get-shit-done', 'VERSION')), false);
  });

  test('require-push fails when the validated candidate cannot be pushed', () => {
    const fixture = setupRepos();
    writeFile(fixture.originBare, 'hooks/pre-receive', '#!/usr/bin/env bash\nexit 1\n', 0o755);

    const result = runScript(fixture, ['--require-push', '--skip-install']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Unable to push origin\/main/);
  });

  test('package.json conflict takes upstream package data and preserves local sync scripts', () => {
    const fixture = setupRepos();
    const localPkg = JSON.parse(fs.readFileSync(path.join(fixture.runner, 'package.json'), 'utf8'));
    localPkg.scripts['sync:upstream:unattended'] = 'bash scripts/unattended-upstream-sync.sh';
    localPkg.scripts['sync:upstream:dry-run'] = 'bash scripts/unattended-upstream-sync.sh --dry-run';
    fs.writeFileSync(path.join(fixture.runner, 'package.json'), `${JSON.stringify(localPkg, null, 2)}\n`);
    commitAll(fixture.runner, 'local sync scripts');

    const upstreamPkg = JSON.parse(fs.readFileSync(path.join(fixture.upstreamWork, 'package.json'), 'utf8'));
    upstreamPkg.version = '10.0.0';
    upstreamPkg.scripts.lint = 'node lint.js';
    fs.writeFileSync(path.join(fixture.upstreamWork, 'package.json'), `${JSON.stringify(upstreamPkg, null, 2)}\n`);
    commitAll(fixture.upstreamWork, 'upstream package update');
    git(['push', 'origin', 'HEAD:main'], fixture.upstreamWork);

    const result = runScript(fixture);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const mergedPkg = JSON.parse(showFromBare(fixture.originBare, 'main', 'package.json'));
    assert.equal(mergedPkg.version, '10.0.0');
    assert.equal(mergedPkg.scripts.lint, 'node lint.js');
    assert.equal(mergedPkg.scripts['sync:upstream:unattended'], 'bash scripts/unattended-upstream-sync.sh');
    assert.equal(mergedPkg.scripts['sync:upstream:dry-run'], 'bash scripts/unattended-upstream-sync.sh --dry-run');
  });

  test('rejects unsafe GSD_SYNC_PRESERVE_PATHS entries before promotion or install', () => {
    const unsafePaths = [
      '/tmp/outside',
      '../outside',
      'hooks//evil',
      'hooks/',
      ':(glob)hooks/*',
      '.',
      '..',
      '-rf',
    ];

    for (const unsafePath of unsafePaths) {
      const fixture = setupRepos();

      const result = runScript(fixture, [], { GSD_SYNC_PRESERVE_PATHS: unsafePath });

      assert.notEqual(result.status, 0, `expected ${unsafePath} to be rejected`);
      assert.match(result.stderr + result.stdout, /Unsafe preserve path/);
      assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'base readme');
      assert.equal(fs.existsSync(fixture.installLog), false);
    }
  });

  test('stable-release mode rejects branch refs and prerelease refs before promotion or install', () => {
    const unstableRefs = ['main', 'dev', 'v1.50.0-canary.0', '1.39.0-rc.7', 'refs/tags/v2.0.0-beta.1'];

    for (const upstreamRef of unstableRefs) {
      const fixture = setupRepos();

      const result = runScript(fixture, [
        '--require-stable-upstream-ref',
        '--upstream-ref', upstreamRef,
        '--skip-install',
      ]);

      assert.notEqual(result.status, 0, `expected ${upstreamRef} to be rejected`);
      assert.match(result.stderr + result.stdout, /official stable release tag/);
      assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'base readme');
      assert.equal(fs.existsSync(fixture.installLog), false);
    }
  });

  test('stable-release mode accepts stable release tag refs', () => {
    const fixture = setupRepos();
    const upstreamHead = git(['rev-parse', 'HEAD'], fixture.upstreamWork);
    git(['tag', 'v9.9.9', upstreamHead], fixture.upstreamWork);
    git(['push', 'origin', 'v9.9.9'], fixture.upstreamWork);

    const result = runScript(fixture, [
      '--require-stable-upstream-ref',
      '--upstream-ref', 'v9.9.9',
      '--skip-install',
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Stable upstream release ref required and accepted: v9\.9\.9/);
    assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'upstream readme');
    assert.equal(fs.existsSync(fixture.installLog), false);
  });

  test('preserves newer fetched origin hardening when local main is stale', () => {
    const fixture = setupRepos();
    const originWork = path.join(path.dirname(fixture.runner), 'origin-work');
    git(['clone', fixture.originBare, originWork], path.dirname(fixture.runner));
    configureRepo(originWork);
    writeFile(originWork, 'SECURITY.md', 'origin newer hardened security\n');
    writeFile(originWork, '.github/workflows/hardened.yml', 'name: origin newer hardened workflow\n');
    writeFile(originWork, 'scripts/secret-scan.sh', createScanner('secret-new'), 0o755);
    commitAll(originWork, 'origin hardening update');
    git(['push', 'origin', 'HEAD:main'], originWork);
    assert.equal(git(['show', 'HEAD:SECURITY.md'], fixture.runner), 'origin hardened security');

    const result = runScript(fixture, ['--skip-install']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(showFromBare(fixture.originBare, 'main', 'README.md'), 'upstream readme');
    assert.equal(showFromBare(fixture.originBare, 'main', 'SECURITY.md'), 'origin newer hardened security');
    assert.equal(showFromBare(fixture.originBare, 'main', '.github/workflows/hardened.yml'), 'name: origin newer hardened workflow');
    assert.equal(showFromBare(fixture.originBare, 'main', 'scripts/secret-scan.sh'), createScanner('secret-new').trim());
  });
});
