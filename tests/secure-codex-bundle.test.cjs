const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, '.github', 'scripts', 'build-secure-codex-bundle.mjs');
const ORIGIN_URL = 'https://github.com/example/private-gsd.git';
const UPSTREAM_URL = 'https://github.com/gsd-build/get-shit-done.git';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

function fixture(installerBody = '') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-codex-bundle-test-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'UPSTREAM-SEED'), 'upstream release\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'upstream release']);
  const upstreamSha = git(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture-gsd","version":"9.8.7"}\n');
  fs.writeFileSync(path.join(repo, 'bin', 'install.js'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.SECRET_TOKEN) {
  throw new Error('credential environment leaked to candidate');
}
const index = process.argv.indexOf('--config-dir');
if (index === -1) throw new Error('missing --config-dir');
const target = process.argv[index + 1];
const write = (relative, content, mode = 0o644) => {
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
};
write('get-shit-done/VERSION', '9.8.7');
write('skills/gsd-test/SKILL.md', '---\\nname: gsd-test\\n---\\n');
write('agents/gsd-test.toml', 'instructions = "' + target.replaceAll('\\\\', '/') + '/get-shit-done/agents/gsd-test.md"\\n');
write('config.toml', 'config_file = "' + target.replaceAll('\\\\', '/') + '/agents/gsd-test.toml"\\n');
write('hooks/gsd-test.sh', '#!/bin/sh\\nexit 0\\n', 0o755);
write('gsd-file-manifest.json', '{}\\n');
write('package.json', '{"type":"commonjs"}\\n');
${installerBody}
`);
  fs.chmodSync(path.join(repo, 'bin', 'install.js'), 0o755);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  git(repo, ['remote', 'add', 'origin', ORIGIN_URL]);
  git(repo, ['remote', 'add', 'upstream', UPSTREAM_URL]);
  git(repo, ['tag', 'v9.8.7', upstreamSha]);
  git(repo, [
    'update-ref',
    '-m', 'fetch --no-tags upstream refs/tags/v9.8.7:refs/remotes/upstream/tags/v9.8.7: storing tag',
    'refs/remotes/upstream/tags/v9.8.7',
    upstreamSha,
  ]);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', sha]);
  const fakeBin = path.join(base, 'fake-bin');
  const remoteResponse = path.join(base, 'ls-remote-response');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "ls-remote" ]; then
    exec /bin/cat ${JSON.stringify(remoteResponse)}
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`);
  fs.chmodSync(path.join(fakeBin, 'git'), 0o755);
  fs.writeFileSync(remoteResponse, `${upstreamSha}\trefs/tags/v9.8.7\n`);
  return {
    base,
    repo,
    sha,
    tree: git(repo, ['rev-parse', 'HEAD^{tree}']),
    upstreamSha,
    fakeBin,
    remoteResponse,
  };
}

function run(f, name, overrides = {}) {
  const stage = path.join(f.base, `stage-${name}`);
  const output = path.join(f.base, `output-${name}`);
  const args = [
    SCRIPT,
    '--repo', f.repo,
    '--staging-root', stage,
    '--output-dir', output,
    '--promoted-sha', overrides.promotedSha || f.sha,
    '--promoted-tree-sha', overrides.promotedTreeSha || f.tree,
    '--origin-url', ORIGIN_URL,
    '--upstream-url', overrides.upstreamUrl || UPSTREAM_URL,
    '--upstream-ref', overrides.upstreamRef || 'v9.8.7',
    '--upstream-sha', overrides.upstreamSha || f.upstreamSha,
    '--expected-version', overrides.expectedVersion || '9.8.7',
    '--run-id', overrides.runId || '123456789',
    '--run-attempt', overrides.runAttempt || '2',
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.fakeBin}${path.delimiter}${process.env.PATH}`,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'example/private-gsd',
      GITHUB_WORKFLOW_REF: 'example/private-gsd/.github/workflows/hardened-upstream-sync.yml@refs/heads/main',
      GITHUB_SHA: f.sha,
      GITHUB_RUN_ID: '123456789',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_TOKEN: 'must-not-reach-candidate',
      GH_TOKEN: 'must-not-reach-candidate',
      SECRET_TOKEN: 'must-not-reach-candidate',
      ...overrides.env,
    },
  });
  return { ...result, output, stage };
}

function manifest(result) {
  return JSON.parse(fs.readFileSync(path.join(result.output, 'secure-codex-manifest.json'), 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function tarEntries(file) {
  const bytes = fs.readFileSync(file);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const name = text(0, 100);
    const prefix = text(345, 155);
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    const mode = Number.parseInt(text(100, 8).trim(), 8);
    const relative = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    entries.set(relative.replace(/\/$/, ''), {
      mode,
      type: text(156, 1) || '0',
      content: bytes.subarray(dataStart, dataStart + size),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('emits a deterministic canonical manifest and bundle independent of the staging path', () => {
  const f = fixture();
  const first = run(f, 'one');
  const second = run(f, 'two');
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(second.status, 0, second.stderr + second.stdout);

  const firstManifestBytes = fs.readFileSync(path.join(first.output, 'secure-codex-manifest.json'));
  const secondManifestBytes = fs.readFileSync(path.join(second.output, 'secure-codex-manifest.json'));
  assert.deepEqual(firstManifestBytes, secondManifestBytes);
  assert.deepEqual(
    fs.readFileSync(path.join(first.output, 'secure-codex-bundle.tar')),
    fs.readFileSync(path.join(second.output, 'secure-codex-bundle.tar')),
  );

  const value = manifest(first);
  assert.equal(value.format, 'gsd-secure-codex-bundle-v1');
  assert.deepEqual(value.repository, {
    github: 'example/private-gsd',
    originUrl: ORIGIN_URL,
    upstreamUrl: UPSTREAM_URL,
  });
  assert.deepEqual(value.promotion, {
    commitSha: f.sha,
    treeSha: f.tree,
    upstreamRef: 'v9.8.7',
    upstreamSha: f.upstreamSha,
  });
  assert.equal(value.version, '9.8.7');
  assert.deepEqual(value.workflow, {
    ref: 'example/private-gsd/.github/workflows/hardened-upstream-sync.yml@refs/heads/main',
    runId: '123456789',
    runAttempt: '2',
  });
  assert.deepEqual(value.entries, [...value.entries].sort((a, b) => a.path.localeCompare(b.path)));
  const directory = value.entries.find(entry => entry.path === 'hooks');
  assert.deepEqual(directory, {
    path: 'hooks',
    type: 'directory',
    mode: '0755',
    bytes: 0,
    sha256: crypto.createHash('sha256').update('').digest('hex'),
  });
  const tar = path.join(first.output, 'secure-codex-bundle.tar');
  assert.deepEqual([...tarEntries(tar).keys()].sort(), value.entries.map(entry => entry.path).sort());
  assert.equal(value.bundle.sha256, sha256(tar));
  assert.equal(value.bundle.bytes, fs.statSync(tar).size);
  assert.equal(firstManifestBytes.at(-1), 0x0a, 'canonical JSON has exactly one trailing newline');
});

test('dereferences an annotated tag returned directly by the upstream remote', () => {
  const f = fixture();
  fs.writeFileSync(
    f.remoteResponse,
    `${'e'.repeat(40)}\trefs/tags/v9.8.7\n${f.upstreamSha}\trefs/tags/v9.8.7^{}\n`,
  );
  const result = run(f, 'annotated-upstream-tag');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(manifest(result).promotion.upstreamSha, f.upstreamSha);
});

test('binds the build to exact promoted commit and tree SHAs from the GitHub checkout', async (t) => {
  const f = fixture();
  await t.test('rejects a commit mismatch', () => {
    const result = run(f, 'bad-commit', { promotedSha: 'b'.repeat(40) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /promoted commit|GITHUB_SHA|HEAD/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects a tree mismatch', () => {
    const result = run(f, 'bad-tree', { promotedTreeSha: 'c'.repeat(40) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tree/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects an upstream SHA not reachable from the promoted commit', () => {
    const result = run(f, 'bad-upstream', { upstreamSha: 'd'.repeat(40) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /upstream|reachable|commit/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects an upstream URL not configured on the upstream remote', () => {
    git(f.repo, ['remote', 'set-url', 'upstream', 'https://github.com/example/wrong.git']);
    const result = run(f, 'bad-upstream-url');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /upstream.*URL|remote/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects a configured GitHub upstream other than the trusted official repository', () => {
    const wrongUpstream = 'https://github.com/example/lookalike-gsd.git';
    git(f.repo, ['remote', 'set-url', 'upstream', wrongUpstream]);
    const result = run(f, 'untrusted-upstream-repository', { upstreamUrl: wrongUpstream });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /trusted.*upstream|official.*upstream|gsd-build/i);
    assert.equal(fs.existsSync(result.output), false);
    git(f.repo, ['remote', 'set-url', 'upstream', UPSTREAM_URL]);
  });
  await t.test('rejects an upstream ref that does not resolve exactly to the declared SHA', () => {
    git(f.repo, ['remote', 'set-url', 'upstream', UPSTREAM_URL]);
    git(f.repo, ['tag', '-f', 'v9.8.7', f.sha]);
    const result = run(f, 'bad-upstream-ref');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /upstream.*ref|tag|SHA/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects a local tag when the required upstream tracking ref is missing', () => {
    git(f.repo, ['tag', '-f', 'v9.8.7', f.upstreamSha]);
    git(f.repo, ['update-ref', '-d', 'refs/remotes/upstream/tags/v9.8.7']);
    const result = run(f, 'missing-upstream-tracking-ref');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /upstream.*tracking|fetched.*upstream|remote.*ref/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects forged local refs and reflog when the upstream remote resolves the tag differently', () => {
    git(f.repo, [
      'update-ref',
      '-m', 'fetch --no-tags upstream refs/tags/v9.8.7:refs/remotes/upstream/tags/v9.8.7: storing tag',
      'refs/remotes/upstream/tags/v9.8.7',
      f.upstreamSha,
    ]);
    fs.writeFileSync(f.remoteResponse, `${f.sha}\trefs/tags/v9.8.7\n`);
    const result = run(f, 'direct-remote-mismatch');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /upstream.*remote|remote.*tag|resolved.*SHA/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects a non-CI invocation', () => {
    const result = run(f, 'not-ci', { env: { GITHUB_ACTIONS: 'false' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GitHub Actions/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects workflow run identity claims that differ from GitHub environment', () => {
    fs.writeFileSync(f.remoteResponse, `${f.upstreamSha}\trefs/tags/v9.8.7\n`);
    const wrongRun = run(f, 'wrong-run-id', { runId: '987654321' });
    assert.notEqual(wrongRun.status, 0);
    assert.match(wrongRun.stderr, /GITHUB_RUN_ID|run.*identity|run ID/i);
    const wrongAttempt = run(f, 'wrong-run-attempt', { runAttempt: '3' });
    assert.notEqual(wrongAttempt.status, 0);
    assert.match(wrongAttempt.stderr, /GITHUB_RUN_ATTEMPT|run.*attempt/i);
    const missingRun = run(f, 'missing-github-run-id', { env: { GITHUB_RUN_ID: '' } });
    assert.notEqual(missingRun.status, 0);
    assert.match(missingRun.stderr, /GITHUB_RUN_ID|run.*identity|run ID/i);
  });
  await t.test('rejects another workflow or an untrusted workflow ref', () => {
    const anotherWorkflow = run(f, 'wrong-workflow', {
      env: { GITHUB_WORKFLOW_REF: 'example/private-gsd/.github/workflows/test.yml@refs/heads/main' },
    });
    assert.notEqual(anotherWorkflow.status, 0);
    assert.match(anotherWorkflow.stderr, /GITHUB_WORKFLOW_REF|hardened-upstream-sync/i);
    const wrongRef = run(f, 'wrong-workflow-ref', {
      env: { GITHUB_WORKFLOW_REF: 'example/private-gsd/.github/workflows/hardened-upstream-sync.yml@refs/heads/feature' },
    });
    assert.notEqual(wrongRef.status, 0);
    assert.match(wrongRef.stderr, /GITHUB_WORKFLOW_REF|trusted.*ref/i);
  });
});

test('rejects actual control characters in absolute paths before creating output', () => {
  const f = fixture();
  const result = run(f, 'bad\npath');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute path|unsafe characters|control/i);
  assert.equal(fs.existsSync(result.output), false);
  assert.throws(
    () => spawnSync(process.execPath, [SCRIPT, '--repo', '/tmp/bad\0path']),
    /null bytes|without null bytes|invalid.*value/i,
  );
});

test('rejects malicious paths, symlinks, hardlinks, and unexpected top-level entries', async (t) => {
  const attacks = {
    'portable traversal path': `write('skills\\\\..\\\\escape', 'bad');`,
    symlink: `fs.symlinkSync('/etc/passwd', path.join(target, 'skills', 'gsd-link'));`,
    'staging root symlink replacement': `const moved = target + '-moved'; fs.renameSync(target, moved); fs.symlinkSync(moved, target);`,
    hardlink: `fs.linkSync(path.join(target, 'config.toml'), path.join(target, 'agents', 'hardlink.toml'));`,
    'unexpected top-level entry': `write('unmanaged.txt', 'bad');`,
  };
  for (const [name, body] of Object.entries(attacks)) {
    await t.test(name, () => {
      const f = fixture(body);
      const result = run(f, name.replaceAll(' ', '-'));
      assert.notEqual(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stderr, /unsafe|symlink|hardlink|unexpected|path/i);
      assert.equal(fs.existsSync(result.output), false);
    });
  }
});

test('preserves executable file modes in both manifest and deterministic tar', () => {
  const f = fixture();
  const result = run(f, 'modes');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const value = manifest(result);
  assert.equal(value.entries.find(file => file.path === 'hooks/gsd-test.sh').mode, '0755');
  assert.equal(value.entries.find(file => file.path === 'config.toml').mode, '0644');
  const entries = tarEntries(path.join(result.output, 'secure-codex-bundle.tar'));
  assert.equal(entries.get('hooks/gsd-test.sh').mode, 0o755);
  assert.equal(entries.get('config.toml').mode, 0o644);
});

test('requires source package, installed VERSION, and declared version to agree exactly', async (t) => {
  await t.test('rejects an installed VERSION mismatch', () => {
    const f = fixture(`write('get-shit-done/VERSION', '0.0.0');`);
    const result = run(f, 'installed-version-mismatch');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /VERSION|version mismatch/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects a declared expected-version mismatch', () => {
    const f = fixture();
    const result = run(f, 'expected-version-mismatch', { expectedVersion: '9.8.6' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected.*version|version mismatch/i);
    assert.equal(fs.existsSync(result.output), false);
  });
  await t.test('rejects expected-version that is not the normalized upstream release tag', () => {
    const f = fixture();
    const result = run(f, 'tag-version-mismatch', { upstreamRef: 'v1.2.3' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /upstream.*ref.*version|expected.*version|normalized/i);
    assert.equal(fs.existsSync(result.output), false);
  });
});

test('rejects a managed file mutated concurrently while it is being copied', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-codex-bundle-race-hook-'));
  const preload = path.join(base, 'race-read-hook.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
if (process.argv[1] !== process.env.GSD_RACE_BUILDER_SCRIPT) return;
fs.appendFileSync(process.env.GSD_RACE_TRACE_FILE, 'builder\\n');
const originalOpenSync = fs.openSync;
const originalFstatSync = fs.fstatSync;
const originalReadFileSync = fs.readFileSync;
const raceDescriptors = new Set();
fs.openSync = function (file, ...args) {
  const descriptor = originalOpenSync.call(this, file, ...args);
  const stat = originalFstatSync.call(this, descriptor, { bigint: true });
  try {
    const raceStat = fs.statSync(process.env.GSD_RACE_FILE, { bigint: true });
    if (stat.dev === raceStat.dev && stat.ino === raceStat.ino) {
      raceDescriptors.add(descriptor);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return descriptor;
};
fs.readFileSync = function (file, ...args) {
  if (typeof file === 'number' && raceDescriptors.has(file)) {
    raceDescriptors.delete(file);
    fs.writeFileSync(process.env.GSD_RACE_FILE, Buffer.alloc(8 * 1024 * 1024, 0x42));
    fs.appendFileSync(process.env.GSD_RACE_TRACE_FILE, 'mutated-at-read\\n');
  }
  return originalReadFileSync.call(this, file, ...args);
};
`);
  const f = fixture(`
write('get-shit-done/race.bin', Buffer.alloc(8 * 1024 * 1024, 0x41));
`);
  const raceFile = path.join(f.base, 'stage-file-race', 'get-shit-done', 'race.bin');
  const result = run(f, 'file-race', {
    env: {
      NODE_OPTIONS: `--require=${preload}`,
      GSD_RACE_BUILDER_SCRIPT: SCRIPT,
      GSD_RACE_FILE: raceFile,
      GSD_RACE_TRACE_FILE: path.join(base, 'race-hook-trace'),
    },
  });
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.ok(result.stderr.includes('File changed while building bundle: get-shit-done/race.bin'), result.stderr + result.stdout);
  assert.equal(fs.existsSync(result.output), false);
  assert.equal(fs.readFileSync(path.join(base, 'race-hook-trace'), 'utf8'), 'builder\nmutated-at-read\n');
});

test('replaces only approved generated Codex-home paths with an unambiguous placeholder', async (t) => {
  await t.test('canonicalizes config and agent TOML paths', () => {
    const f = fixture();
    const result = run(f, 'placeholder');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const entries = tarEntries(path.join(result.output, 'secure-codex-bundle.tar'));
    assert.equal(entries.get('config.toml').content.toString(), 'config_file = "{{GSD_CODEX_HOME}}/agents/gsd-test.toml"\n');
    assert.match(entries.get('agents/gsd-test.toml').content.toString(), /\{\{GSD_CODEX_HOME\}\}\/get-shit-done/);
    assert.deepEqual(manifest(result).transformations, [{
      placeholder: '{{GSD_CODEX_HOME}}',
      paths: ['agents/gsd-test.toml', 'config.toml'],
    }]);
  });

  await t.test('rejects a placeholder collision', () => {
    const f = fixture(`write('hooks/collision.js', '{{GSD_CODEX_HOME}}');`);
    const result = run(f, 'placeholder-collision');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /placeholder|unsafe transformation/i);
    assert.equal(fs.existsSync(result.output), false);
  });

  await t.test('rejects a staging-root reference outside approved TOML outputs', () => {
    const f = fixture(`write('hooks/leak.js', target);`);
    const result = run(f, 'placeholder-scope');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /placeholder|transformation|staging/i);
    assert.equal(fs.existsSync(result.output), false);
  });
});
