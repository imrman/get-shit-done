// allow-test-rule: workflow-signing-shell-is-the-security-boundary
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'hardened-upstream-sync.yml'),
  'utf8',
);
const NAMESPACE = 'gsd-secure-codex-bundle@imrman.local';
const IDENTITY = 'gsd-bundle-signing@imrman.local';
const VALUES = {
  repository: 'example/private-gsd',
  promotedSha: 'a'.repeat(40),
  promotedTreeSha: 'b'.repeat(40),
  upstreamRef: 'v9.8.7',
  upstreamSha: 'c'.repeat(40),
  runId: '123456789',
  runAttempt: '2',
};

function namedJobBlock(workflow, jobName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `Missing workflow job: ${jobName}`);
  let end = start + 1;
  while (end < lines.length && !/^  [A-Za-z0-9_-]+:/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

function signingScript() {
  const job = namedJobBlock(WORKFLOW, 'sign_secure_codex');
  const lines = job.split('\n');
  const step = lines.findIndex((line) => line.includes('- name: Sign and self-verify secure Codex manifest'));
  assert.notEqual(step, -1, 'Missing signing step');
  const run = lines.findIndex((line, index) => index > step && /^\s+run:\s*\|\s*$/.test(line));
  assert.notEqual(run, -1, 'Signing step must use a literal run block');
  const indent = lines[run].match(/^(\s*)/)[1].length + 2;
  const body = [];
  for (let index = run + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && lines[index].match(/^\s*/)[0].length < indent) break;
    body.push(lines[index].slice(indent));
  }
  return body.join('\n');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function generateKey(directory, name = 'key') {
  const key = path.join(directory, name);
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const fingerprint = spawnSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${key}.pub`], { encoding: 'utf8' });
  assert.equal(fingerprint.status, 0, fingerprint.stderr);
  return {
    privateKey: fs.readFileSync(key, 'utf8'),
    publicKey: fs.readFileSync(`${key}.pub`, 'utf8').trim(),
    fingerprint: fingerprint.stdout.trim().split(/\s+/)[1],
  };
}

function canonicalManifest(bundle) {
  return {
    format: 'gsd-secure-codex-bundle-v1',
    repository: {
      github: VALUES.repository,
      originUrl: `https://github.com/${VALUES.repository}`,
      upstreamUrl: 'https://github.com/gsd-build/get-shit-done.git',
    },
    promotion: {
      commitSha: VALUES.promotedSha,
      treeSha: VALUES.promotedTreeSha,
      upstreamRef: VALUES.upstreamRef,
      upstreamSha: VALUES.upstreamSha,
    },
    version: '9.8.7',
    workflow: {
      ref: `${VALUES.repository}/.github/workflows/hardened-upstream-sync.yml@refs/heads/main`,
      runId: VALUES.runId,
      runAttempt: VALUES.runAttempt,
    },
    transformations: [],
    entries: [],
    bundle: {
      name: 'secure-codex-bundle.tar',
      bytes: bundle.length,
      sha256: sha256(bundle),
    },
  };
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-codex-signing-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = path.join(temp, 'secure-codex-signing-input');
  fs.mkdirSync(input);
  const bundle = Buffer.from('deterministic bundle fixture\n');
  fs.writeFileSync(path.join(input, 'secure-codex-bundle.tar'), bundle);
  fs.writeFileSync(
    path.join(input, 'secure-codex-manifest.json'),
    `${JSON.stringify(canonicalManifest(bundle), null, 2)}\n`,
  );
  return { temp, input, key: generateKey(temp) };
}

function runSigner(f, overrides = {}) {
  return spawnSync('bash', ['-c', signingScript()], {
    cwd: f.temp,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: f.temp,
      EXPECTED_REPOSITORY: VALUES.repository,
      EXPECTED_WORKFLOW_REF: `${VALUES.repository}/.github/workflows/hardened-upstream-sync.yml@refs/heads/main`,
      EXPECTED_RUN_ID: VALUES.runId,
      EXPECTED_RUN_ATTEMPT: VALUES.runAttempt,
      EXPECTED_PROMOTED_SHA: VALUES.promotedSha,
      EXPECTED_PROMOTED_TREE_SHA: VALUES.promotedTreeSha,
      EXPECTED_UPSTREAM_REF: VALUES.upstreamRef,
      EXPECTED_UPSTREAM_SHA: VALUES.upstreamSha,
      SIGNING_PRIVATE_KEY: f.key.privateKey,
      EXPECTED_SIGNING_FINGERPRINT: f.key.fingerprint,
      ...overrides,
    },
  });
}

function verify(manifest, signature, publicKey, { namespace = NAMESPACE, identity = IDENTITY } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-codex-signature-verify-'));
  const allowed = path.join(temp, 'allowed-signers');
  fs.writeFileSync(allowed, `${IDENTITY} ${publicKey}\n`);
  try {
    return spawnSync('ssh-keygen', [
      '-Y', 'verify', '-f', allowed, '-I', identity, '-n', namespace, '-s', signature,
    ], { input: manifest, encoding: 'utf8' });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

describe('secure Codex OpenSSH bundle signing', () => {
  test('signs the exact manifest and emits only tar, manifest, and signature', (t) => {
    const f = fixture(t);
    const result = runSigner(f);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = path.join(f.temp, 'secure-codex-signed-output');
    assert.deepEqual(fs.readdirSync(output).sort(), [
      'secure-codex-bundle.tar',
      'secure-codex-manifest.json',
      'secure-codex-manifest.json.sig',
    ]);
    const verified = verify(
      fs.readFileSync(path.join(output, 'secure-codex-manifest.json')),
      path.join(output, 'secure-codex-manifest.json.sig'),
      f.key.publicKey,
    );
    assert.equal(verified.status, 0, verified.stderr + verified.stdout);
    assert.equal(fs.existsSync(path.join(f.temp, 'gsd-bundle-signing-key')), false, 'private key must be deleted by the trap');
  });

  test('signature rejects manifest mutation, wrong namespace, wrong key, and wrong identity', (t) => {
    const f = fixture(t);
    const result = runSigner(f);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = path.join(f.temp, 'secure-codex-signed-output');
    const manifest = fs.readFileSync(path.join(output, 'secure-codex-manifest.json'));
    const signature = path.join(output, 'secure-codex-manifest.json.sig');
    const wrongKey = generateKey(f.temp, 'wrong-key');

    assert.notEqual(verify(Buffer.concat([manifest, Buffer.from(' ')]), signature, f.key.publicKey).status, 0);
    assert.notEqual(verify(manifest, signature, f.key.publicKey, { namespace: 'wrong-namespace' }).status, 0);
    assert.notEqual(verify(manifest, signature, wrongKey.publicKey).status, 0);
    assert.notEqual(verify(manifest, signature, f.key.publicKey, { identity: 'wrong-identity' }).status, 0);
  });

  test('refuses a private key whose derived public fingerprint is not the environment fingerprint', (t) => {
    const f = fixture(t);
    const result = runSigner(f, { EXPECTED_SIGNING_FINGERPRINT: `SHA256:${'x'.repeat(43)}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fingerprint/i);
    assert.equal(fs.existsSync(path.join(f.temp, 'secure-codex-signed-output')), false);
  });

  test('refuses unexpected artifact entries before using the signing key', (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.input, 'unexpected.txt'), 'unexpected');
    const result = runSigner(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly|unexpected|artifact/i);
    assert.equal(fs.existsSync(path.join(f.temp, 'gsd-bundle-signing-key')), false);
    assert.equal(fs.existsSync(path.join(f.temp, 'secure-codex-signed-output')), false);
  });

  test('refuses a canonical manifest whose trusted workflow identity was changed', (t) => {
    const f = fixture(t);
    const manifestPath = path.join(f.input, 'secure-codex-manifest.json');
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    value.promotion.commitSha = 'd'.repeat(40);
    fs.writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
    const result = runSigner(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest|identity|promoted|commit/i);
    assert.equal(fs.existsSync(path.join(f.temp, 'secure-codex-signed-output')), false);
  });
});
