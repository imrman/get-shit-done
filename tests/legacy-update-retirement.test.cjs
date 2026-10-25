// allow-test-rule: retirement-entrypoint-policy-is-the-product
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('former local update entrypoints fail closed without external commands or writes', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-retired-update-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const home = path.join(sandbox, 'home');
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const marker = path.join(sandbox, 'command-called');
  for (const name of ['git', 'npm', 'gh']) {
    const executable = path.join(bin, name);
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\nexit 99\n`, { mode: 0o755 });
  }
  const env = { HOME: home, PATH: bin, UPSTREAM_REPO: 'unused' };
  for (const script of ['scripts/unattended-upstream-sync.sh', '.github/scripts/hardened-upstream-sync.sh']) {
    for (const args of [[], ['--dry-run'], ['--help']]) {
      const result = spawnSync('/bin/bash', [path.join(root, script), ...args], { cwd: sandbox, env, encoding: 'utf8' });
      assert.equal(result.status, 1, `${script} ${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, /retired.*OpenGSD/i);
    }
  }
  for (const hook of ['hooks/gsd-check-update.js', 'hooks/gsd-check-update-worker.js', 'hooks/gsd-update-banner.js']) {
    const result = spawnSync(process.execPath, [path.join(root, hook)], { cwd: sandbox, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${hook}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  assert.equal(fs.existsSync(marker), false, 'no git, npm or gh command may run');
  assert.deepEqual(fs.readdirSync(home), [], 'hooks must not create cache or config files');
  const statusline = fs.readFileSync(path.join(root, 'hooks/gsd-statusline.js'), 'utf8');
  assert.doesNotMatch(statusline, /gsd-update-check\.json|\/gsd-update/, 'statusline must not suggest the retired update path');
});

test('legacy workflow and package update launchers are absent', () => {
  for (const name of ['hardened-upstream-sync.yml', 'hotfix.yml', 'release.yml']) {
    assert.equal(fs.existsSync(path.join(root, '.github', 'workflows', name)), false, `${name} must be retired`);
  }
  const scripts = require('../package.json').scripts;
  assert.equal(Object.hasOwn(scripts, 'sync:upstream:unattended'), false);
  assert.equal(Object.hasOwn(scripts, 'sync:upstream:dry-run'), false);
  for (const name of ['test.yml', 'security-scan.yml', 'install-smoke.yml']) {
    assert.equal(fs.existsSync(path.join(root, '.github', 'workflows', name)), true);
  }
});

test('legacy update instructions contain a retirement notice and no install command', () => {
  for (const name of ['commands/gsd/update.md', 'get-shit-done/workflows/update.md', 'docs/manual-update.md']) {
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(content, /retired/i);
    assert.match(content, /OpenGSD/);
    assert.doesNotMatch(content, /(?:get-shit-done-cc|npm\s+(?:install|i)|npx\s+|git\s+pull)/i);
  }
});


test('retired command cannot import an installed legacy updater', () => {
  const command = fs.readFileSync(path.join(root, 'commands/gsd/update.md'), 'utf8');
  assert.doesNotMatch(command, /<execution_context(?:_extended)?>|@~\/\.claude\/get-shit-done\/workflows\/update\.md/);
  assert.doesNotMatch(command, /allowed-tools:|\bBash\b/);
});

test('active help, quick and project workflows do not recommend the retired installers', () => {
  for (const name of [
    'get-shit-done/workflows/help.md',
    'get-shit-done/workflows/quick.md',
    'get-shit-done/workflows/new-project.md',
    'get-shit-done/workflows/new-milestone.md',
  ]) {
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(content, /npx\s+get-shit-done-cc|npm\s+install\s+-g\s+@gsd-build\/sdk/, name);
  }
  const help = fs.readFileSync(path.join(root, 'get-shit-done/workflows/help.md'), 'utf8');
  assert.match(help, /legacy command is retired/i);
  const quick = fs.readFileSync(path.join(root, 'get-shit-done/workflows/quick.md'), 'utf8');
  assert.match(quick, /legacy SDK installer is retired/i);
});

test('active README editions and command references show retirement without executable legacy install lines', () => {
  for (const name of [
    'README.md', 'README.ja-JP.md', 'README.ko-KR.md',
    'README.pt-BR.md', 'README.zh-CN.md', 'docs/zh-CN/README.md',
  ]) {
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(content, /OpenGSD/);
    assert.doesNotMatch(content, /^\s*(?:npx\s+get-shit-done-cc|npm\s+install\s+-g\s+@gsd-build\/sdk)/m, name);
  }
  for (const name of [
    'docs/COMMANDS.md', 'docs/ja-JP/COMMANDS.md',
    'docs/ko-KR/COMMANDS.md', 'docs/pt-BR/COMMANDS.md',
  ]) {
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(content, /OpenGSD/);
    assert.doesNotMatch(content, /^\s*\/gsd-update\s+#/m, name);
  }
});
