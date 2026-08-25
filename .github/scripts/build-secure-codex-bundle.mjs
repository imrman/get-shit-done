#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLACEHOLDER = '{{GSD_CODEX_HOME}}';
const TRUSTED_UPSTREAM_URL = 'https://github.com/gsd-build/get-shit-done.git';
const TOP_LEVEL = new Set([
  'agents',
  'config.toml',
  'get-shit-done',
  'gsd-file-manifest.json',
  'hooks',
  'package.json',
  'skills',
]);
const REQUIRED = [
  'config.toml',
  'get-shit-done/VERSION',
  'gsd-file-manifest.json',
  'package.json',
];
const SHA_RE = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = {};
  const allowed = new Set([
    'repo', 'staging-root', 'output-dir', 'promoted-sha',
    'promoted-tree-sha', 'origin-url', 'upstream-url', 'upstream-ref',
    'upstream-sha', 'expected-version', 'run-id', 'run-attempt',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) fail(`Invalid argument: ${option || '(empty)'}`);
    const name = option.slice(2);
    if (!allowed.has(name) || Object.hasOwn(values, name)) fail(`Unknown or duplicate option: ${option}`);
    values[name] = value;
  }
  for (const name of allowed) {
    if (!values[name]) fail(`--${name} is required`);
  }
  return values;
}

function safeText(value, label) {
  if (/[^\x20-\x7e]/.test(value)) fail(`${label} contains unsafe characters`);
  return value;
}

function exactSha(value, label) {
  if (!SHA_RE.test(value)) fail(`${label} must be an exact lowercase 40-character SHA`);
  return value;
}

function githubUrl(value, label) {
  safeText(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(`${label} must be a credential-free GitHub HTTPS URL`);
  }
  return value;
}

function cleanAbsolute(value, label) {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.includes(PLACEHOLDER)) {
    fail(`${label} must be a safe absolute path`);
  }
  return path.resolve(value);
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
  }).trim();
}

function resolveRemoteTag(upstreamUrl, upstreamRef) {
  const tagRef = `refs/tags/${upstreamRef}`;
  let output;
  try {
    output = execFileSync('git', [
      '-c', 'credential.helper=',
      '-c', 'core.askPass=',
      'ls-remote', '--exit-code', upstreamUrl, tagRef, `${tagRef}^{}`,
    ], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_ASKPASS: '/bin/false',
      },
    });
  } catch {
    fail('Unable to resolve the exact tag directly from the upstream remote');
  }

  const resolved = new Map();
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{40})\t(.+)$/);
    if (!match || (match[2] !== tagRef && match[2] !== `${tagRef}^{}`) || resolved.has(match[2])) {
      fail('Upstream remote returned an unsafe or ambiguous tag resolution');
    }
    resolved.set(match[2], match[1]);
  }
  if (!resolved.has(tagRef)) fail('Upstream remote did not return the declared tag');
  return resolved.get(`${tagRef}^{}`) || resolved.get(tagRef);
}

function ensureIdentity(options) {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    fail('This builder may run only in GitHub Actions CI');
  }
  exactSha(options['promoted-sha'], 'Promoted commit SHA');
  exactSha(options['promoted-tree-sha'], 'Promoted tree SHA');
  exactSha(options['upstream-sha'], 'Upstream SHA');
  if (options['upstream-url'] !== TRUSTED_UPSTREAM_URL) {
    fail(`Official trusted upstream must exactly equal ${TRUSTED_UPSTREAM_URL}`);
  }
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(options['upstream-ref'])) fail('Upstream ref must be a stable release tag');
  const normalizedVersion = options['upstream-ref'].startsWith('v')
    ? options['upstream-ref'].slice(1)
    : options['upstream-ref'];
  if (options['expected-version'] !== normalizedVersion) {
    fail('Expected version must exactly equal the normalized upstream ref version');
  }
  if (!/^[1-9][0-9]*$/.test(options['run-id']) || !/^[1-9][0-9]*$/.test(options['run-attempt'])) {
    fail('Workflow run ID and attempt must be positive integers');
  }
  if (!process.env.GITHUB_RUN_ID || options['run-id'] !== process.env.GITHUB_RUN_ID) {
    fail('Run ID must exactly match nonempty GITHUB_RUN_ID');
  }
  if (!process.env.GITHUB_RUN_ATTEMPT || options['run-attempt'] !== process.env.GITHUB_RUN_ATTEMPT) {
    fail('Run attempt must exactly match nonempty GITHUB_RUN_ATTEMPT');
  }
  const githubRepository = safeText(process.env.GITHUB_REPOSITORY || '', 'GITHUB_REPOSITORY');
  const workflowRef = safeText(process.env.GITHUB_WORKFLOW_REF || '', 'GITHUB_WORKFLOW_REF');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) fail('GITHUB_REPOSITORY is missing or unsafe');
  const trustedWorkflowRef = `${githubRepository}/.github/workflows/hardened-upstream-sync.yml@refs/heads/main`;
  if (workflowRef !== trustedWorkflowRef) fail(`GITHUB_WORKFLOW_REF must exactly equal ${trustedWorkflowRef}`);
  if (process.env.GITHUB_SHA !== options['promoted-sha']) fail('GITHUB_SHA does not equal the promoted commit SHA');
  return { githubRepository, workflowRef };
}

function preparePaths(options) {
  const repoInput = cleanAbsolute(options.repo, 'Repository');
  const repoStat = fs.lstatSync(repoInput);
  if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) fail('Repository must be a real directory, not a symlink');
  const repo = fs.realpathSync(repoInput);
  if (git(repo, ['rev-parse', '--show-toplevel']) !== repo) fail('Repository must name the Git worktree root');

  const stageInput = cleanAbsolute(options['staging-root'], 'Staging root');
  const outputInput = cleanAbsolute(options['output-dir'], 'Output directory');
  const stage = fs.existsSync(stageInput)
    ? fs.realpathSync(stageInput)
    : path.join(fs.realpathSync(path.dirname(stageInput)), path.basename(stageInput));
  const output = path.join(fs.realpathSync(path.dirname(outputInput)), path.basename(outputInput));
  if (overlaps(repo, stage) || overlaps(repo, output) || overlaps(stage, output)) fail('Repository, staging root, and output directory must not overlap');
  if (fs.existsSync(output)) fail('Output directory must not already exist');
  if (fs.existsSync(stage)) {
    const stat = fs.lstatSync(stage);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(stage).length !== 0) fail('Staging root must be a real empty directory');
  } else {
    fs.mkdirSync(stage, { mode: 0o700 });
  }
  return { repo, stage: fs.realpathSync(stage), output };
}

function verifyRepository(repo, options) {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  if (head !== options['promoted-sha']) fail(`Repository HEAD is not the promoted commit SHA: ${head}`);
  if (tree !== options['promoted-tree-sha']) fail(`Repository tree is not the promoted tree SHA: ${tree}`);
  if (git(repo, ['rev-parse', 'refs/remotes/origin/main^{commit}']) !== head) {
    fail('refs/remotes/origin/main does not equal the promoted commit SHA');
  }
  try {
    git(repo, ['cat-file', '-e', `${options['upstream-sha']}^{commit}`]);
    git(repo, ['merge-base', '--is-ancestor', options['upstream-sha'], head]);
  } catch {
    fail('Declared upstream SHA is not a commit reachable from the promoted commit');
  }
  if (git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])) fail('Promoted repository must be clean');
  const originUrls = git(repo, ['config', '--local', '--get-all', 'remote.origin.url']).split('\n').filter(Boolean);
  if (originUrls.length !== 1 || originUrls[0] !== options['origin-url']) fail('Repository origin URL does not match the declared identity');
  const upstreamUrls = git(repo, ['config', '--local', '--get-all', 'remote.upstream.url']).split('\n').filter(Boolean);
  if (upstreamUrls.length !== 1 || upstreamUrls[0] !== options['upstream-url']) fail('Configured upstream remote URL does not match the declared identity');
  const tagRef = `refs/tags/${options['upstream-ref']}`;
  const trackingRef = `refs/remotes/upstream/tags/${options['upstream-ref']}`;
  let upstreamRefSha;
  let upstreamTrackingSha;
  try {
    upstreamRefSha = git(repo, ['rev-parse', '--verify', `${tagRef}^{commit}`]);
    upstreamTrackingSha = git(repo, ['rev-parse', '--verify', `${trackingRef}^{commit}`]);
  } catch {
    fail('Upstream tag must have a fetched upstream remote-tracking ref');
  }
  if (upstreamRefSha !== options['upstream-sha'] || upstreamTrackingSha !== options['upstream-sha']) {
    fail('Upstream tag and fetched tracking ref must resolve exactly to the declared upstream SHA');
  }
}

function runInstaller(repo, stage) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-secure-bundle-'));
  fs.mkdirSync(path.join(sandbox, 'home'));
  fs.mkdirSync(path.join(sandbox, 'tmp'));
  fs.mkdirSync(path.join(sandbox, 'xdg'));
  const oldUmask = process.umask(0o022);
  try {
    execFileSync(process.execPath, [
      path.join(repo, 'bin', 'install.js'),
      '--codex', '--global', '--no-sdk', '--config-dir', stage,
    ], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: path.join(sandbox, 'home'),
        CODEX_HOME: stage,
        TMPDIR: path.join(sandbox, 'tmp'),
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg'),
        CI: 'true',
        GITHUB_ACTIONS: 'true',
      },
    });
  } finally {
    process.umask(oldUmask);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function safeRelative(relative) {
  if (!relative || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative.includes('\\') || /[\x00-\x1f\x7f]/.test(relative)) {
    fail(`Unsafe bundle path: ${JSON.stringify(relative)}`);
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) fail(`Unsafe bundle path: ${relative}`);
  if (!TOP_LEVEL.has(parts[0])) fail(`Unexpected top-level bundle entry: ${parts[0]}`);
  if (Buffer.byteLength(relative) > 255) fail(`Bundle path is too long: ${relative}`);
}

function collect(stage) {
  const rootStat = fs.lstatSync(stage, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(stage) !== stage) {
    fail('Staging root was replaced by an unsafe symlink or file type');
  }
  const entries = [];
  function walk(directory, prefix = '') {
    const names = fs.readdirSync(directory).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name;
      safeRelative(relative);
      const full = path.join(stage, ...relative.split('/'));
      const stat = fs.lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink()) fail(`Symlink is forbidden in bundle: ${relative}`);
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory', mode: 0o755 });
        walk(full, relative);
        const after = fs.lstatSync(full, { bigint: true });
        if (!sameIdentity(stat, after)) fail(`Directory identity changed while building bundle: ${relative}`);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1n) fail(`Hardlink is forbidden in bundle: ${relative}`);
        const mode = Number(stat.mode & 0o777n);
        if ((mode & 0o022) !== 0 || ![0o600, 0o644, 0o700, 0o755].includes(mode)) fail(`Unsafe file mode in bundle: ${relative}`);
        entries.push({ path: relative, type: 'file', mode, content: readStableFile(full, relative, stat) });
      } else {
        fail(`Unsupported file type in bundle: ${relative}`);
      }
    }
  }
  walk(stage);
  const rootAfter = fs.lstatSync(stage, { bigint: true });
  if (!sameIdentity(rootStat, rootAfter)) fail('Staging root identity changed while building bundle');
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const required of REQUIRED) {
    if (!entries.some(entry => entry.type === 'file' && entry.path === required)) fail(`Required managed file is missing: ${required}`);
  }
  if (!entries.some(entry => entry.type === 'file' && /^skills\/gsd-[^/]+\/SKILL\.md$/.test(entry.path))) {
    fail('Required managed GSD skill is missing');
  }
  return entries;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readStableFile(full, relative, pathStat) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(full, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameIdentity(pathStat, before)) {
      fail(`File identity changed before copy: ${relative}`);
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    let pathAfter;
    try {
      pathAfter = fs.lstatSync(full, { bigint: true });
    } catch {
      fail(`File disappeared while building bundle: ${relative}`);
    }
    if (BigInt(content.length) !== before.size || !sameIdentity(before, after) || !sameIdentity(after, pathAfter)) {
      fail(`File changed while building bundle: ${relative}`);
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function canonicalize(entries, stage) {
  const stageBytes = Buffer.from(stage);
  const placeholderBytes = Buffer.from(PLACEHOLDER);
  const transformed = [];
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    if (entry.content.indexOf(placeholderBytes) !== -1) fail(`Unsafe placeholder collision in ${entry.path}`);
    if (entry.content.indexOf(stageBytes) === -1) continue;
    if (entry.path !== 'config.toml' && !/^agents\/[^/]+\.toml$/.test(entry.path)) {
      fail(`Staging-root transformation is not allowed in ${entry.path}`);
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(entry.content);
    } catch {
      fail(`Unsafe non-text placeholder transformation in ${entry.path}`);
    }
    let cursor = text.indexOf(stage);
    while (cursor !== -1) {
      const following = text[cursor + stage.length];
      if (following !== '/') fail(`Unsafe staging-root transformation boundary in ${entry.path}`);
      cursor = text.indexOf(stage, cursor + stage.length);
    }
    entry.content = Buffer.from(text.replaceAll(stage, PLACEHOLDER));
    transformed.push(entry.path);
  }
  return transformed.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function tarName(relative, directory) {
  const value = directory ? `${relative}/` : relative;
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' };
  for (let slash = value.lastIndexOf('/'); slash > 0; slash = value.lastIndexOf('/', slash - 1)) {
    const prefix = value.slice(0, slash);
    const name = value.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  fail(`Bundle path cannot be represented safely in ustar: ${relative}`);
}

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) fail(`Tar header value is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) fail('Tar numeric field overflow');
  writeString(header, offset, length, `${encoded}\0`);
}

function tarHeader(entry) {
  const header = Buffer.alloc(512);
  const names = tarName(entry.path, entry.type === 'directory');
  writeString(header, 0, 100, names.name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === 'file' ? entry.content.length : 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, entry.type === 'directory' ? '5' : '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, names.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function buildTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    if (entry.type === 'file') {
      chunks.push(entry.content);
      const padding = (512 - entry.content.length % 512) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function publish(output, bundle, manifest) {
  const parent = path.dirname(output);
  const temporary = fs.mkdtempSync(path.join(parent, '.secure-codex-bundle.'));
  try {
    fs.writeFileSync(path.join(temporary, 'secure-codex-bundle.tar'), bundle, { mode: 0o600 });
    fs.writeFileSync(path.join(temporary, 'secure-codex-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  githubUrl(options['origin-url'], 'Origin URL');
  githubUrl(options['upstream-url'], 'Upstream URL');
  const ci = ensureIdentity(options);
  const locations = preparePaths(options);
  verifyRepository(locations.repo, options);
  const remoteUpstreamSha = resolveRemoteTag(options['upstream-url'], options['upstream-ref']);
  if (remoteUpstreamSha !== options['upstream-sha']) {
    fail('Upstream remote tag resolved to a different SHA than the declared upstream SHA');
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(locations.repo, 'package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(packageJson.version)) fail('Repository package version is unsafe');
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(options['expected-version']) || packageJson.version !== options['expected-version']) {
    fail('Source package version does not match --expected-version');
  }

  runInstaller(locations.repo, locations.stage);
  verifyRepository(locations.repo, options);
  const entries = collect(locations.stage);
  const transformations = canonicalize(entries, locations.stage);
  const installedVersion = entries.find(entry => entry.type === 'file' && entry.path === 'get-shit-done/VERSION').content;
  const installedVersionText = new TextDecoder('utf-8', { fatal: true }).decode(installedVersion);
  if (installedVersionText !== options['expected-version'] && installedVersionText !== `${options['expected-version']}\n`) {
    fail('Installed VERSION does not match source package and --expected-version');
  }
  const bundle = buildTar(entries);
  const manifestEntries = entries.map(entry => {
    const content = entry.type === 'file' ? entry.content : Buffer.alloc(0);
    return {
      path: entry.path,
      type: entry.type,
      mode: entry.mode.toString(8).padStart(4, '0'),
      bytes: content.length,
      sha256: sha256(content),
    };
  });
  const manifest = {
    format: 'gsd-secure-codex-bundle-v1',
    repository: {
      github: ci.githubRepository,
      originUrl: options['origin-url'],
      upstreamUrl: options['upstream-url'],
    },
    promotion: {
      commitSha: options['promoted-sha'],
      treeSha: options['promoted-tree-sha'],
      upstreamRef: options['upstream-ref'],
      upstreamSha: options['upstream-sha'],
    },
    version: options['expected-version'],
    workflow: {
      ref: ci.workflowRef,
      runId: options['run-id'],
      runAttempt: options['run-attempt'],
    },
    transformations: transformations.length ? [{ placeholder: PLACEHOLDER, paths: transformations }] : [],
    entries: manifestEntries,
    bundle: {
      name: 'secure-codex-bundle.tar',
      bytes: bundle.length,
      sha256: sha256(bundle),
    },
  };
  publish(locations.output, bundle, manifest);
  process.stdout.write(`BUNDLE_SHA256=${manifest.bundle.sha256}\nMANIFEST=${path.join(locations.output, 'secure-codex-manifest.json')}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
}
