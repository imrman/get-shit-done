/**
 * Unit tests for config mutation handlers.
 *
 * Tests: isValidConfigKey, parseConfigValue, configSet,
 * configSetModelProfile, configNewProject, configEnsureSection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, lstat, rename } from 'node:fs/promises';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GSDError, ErrorClassification } from '../errors.js';

const spawnBoundaryHook = vi.hoisted(() => ({
  callback: undefined as undefined | (() => void),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const childProcess = await importOriginal<typeof import('node:child_process')>();
  return {
    ...childProcess,
    spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) => {
      spawnBoundaryHook.callback?.();
      return childProcess.spawnSync(...args);
    },
  };
});

// ─── Test setup ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'gsd-cfgmut-'));
  await mkdir(join(tmpDir, '.planning'), { recursive: true });
});

afterEach(async () => {
  spawnBoundaryHook.callback = undefined;
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── isValidConfigKey ──────────────────────────────────────────────────────

describe('isValidConfigKey', () => {
  it('accepts known exact keys', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    expect(isValidConfigKey('model_profile').valid).toBe(true);
    expect(isValidConfigKey('commit_docs').valid).toBe(true);
    expect(isValidConfigKey('workflow.auto_advance').valid).toBe(true);
  });

  it('accepts workflow.context_coverage_gate (#2492)', async () => {
    const { isValidConfigKey, parseConfigValue } = await import('./config-mutation.js');
    expect(isValidConfigKey('workflow.context_coverage_gate').valid).toBe(true);
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('false')).toBe(false);
  });

  it('accepts wildcard agent_skills.* patterns', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    expect(isValidConfigKey('agent_skills.gsd-planner').valid).toBe(true);
    expect(isValidConfigKey('agent_skills.custom_agent').valid).toBe(true);
  });

  it('accepts wildcard features.* patterns', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    expect(isValidConfigKey('features.global_learnings').valid).toBe(true);
    expect(isValidConfigKey('features.thinking_partner').valid).toBe(true);
  });

  it('rejects unknown keys with suggestion', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    const result = isValidConfigKey('model_profle');
    expect(result.valid).toBe(false);
    expect(result.suggestion).toBeDefined();
  });

  it('rejects completely invalid keys', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    const result = isValidConfigKey('totally_unknown_key');
    expect(result.valid).toBe(false);
  });

  it('accepts learnings.max_inject as valid key (D7)', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    expect(isValidConfigKey('learnings.max_inject').valid).toBe(true);
  });

  it('accepts features.global_learnings as valid key (D7)', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    expect(isValidConfigKey('features.global_learnings').valid).toBe(true);
  });

  it('returns curated suggestion for known typos before LCP fallback (D9)', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    const r1 = isValidConfigKey('workflow.codereview');
    expect(r1.valid).toBe(false);
    expect(r1.suggestion).toBe('workflow.code_review');

    const r2 = isValidConfigKey('agents.nyquist_validation_enabled');
    expect(r2.valid).toBe(false);
    expect(r2.suggestion).toBe('workflow.nyquist_validation');
  });

  // #2653 — SDK/CJS config-schema drift regression.
  // Every key accepted by the CJS config-set must also be accepted by
  // the SDK config-set. We exercise every entry in the shared schema
  // so drift fails this test the moment it is introduced.
  it('#2653 — accepts every key in shared VALID_CONFIG_KEYS', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    const { VALID_CONFIG_KEYS } = await import('./config-schema.js');
    const rejected: string[] = [];
    for (const key of VALID_CONFIG_KEYS) {
      const { valid } = isValidConfigKey(key);
      if (!valid) rejected.push(key);
    }
    expect(rejected).toEqual([]);
  });

  it('#2653 — accepts sample dynamic keys from every DYNAMIC_KEY_PATTERN', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    const samples = [
      'agent_skills.gsd-planner',
      'review.models.claude',
      'features.some_feature',
      'claude_md_assembly.blocks.intro',
      'model_profile_overrides.codex.opus',
      'model_profile_overrides.codex.sonnet',
      'model_profile_overrides.my-runtime.haiku',
    ];
    for (const key of samples) {
      expect(isValidConfigKey(key).valid, `expected ${key} to be accepted`).toBe(true);
    }
  });

  it('#2653 — accepts planning.sub_repos (CJS/docs key, previously rejected by SDK)', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');
    expect(isValidConfigKey('planning.sub_repos').valid).toBe(true);
  });

  it('rejects prototype-reserved segments in dynamic config keys', async () => {
    const { isValidConfigKey } = await import('./config-mutation.js');

    for (const key of [
      'model_profile_overrides.__proto__.opus',
      'model_profile_overrides.prototype.sonnet',
      'model_profile_overrides.constructor.haiku',
      'model_overrides.__proto__',
      'model_overrides.prototype',
      'model_overrides.constructor',
    ]) {
      expect(isValidConfigKey(key).valid, `expected ${key} to be rejected`).toBe(false);
    }
  });
});

// ─── parseConfigValue ──────────────────────────────────────────────────────

describe('parseConfigValue', () => {
  it('converts "true" to boolean true', async () => {
    const { parseConfigValue } = await import('./config-mutation.js');
    expect(parseConfigValue('true')).toBe(true);
  });

  it('converts "false" to boolean false', async () => {
    const { parseConfigValue } = await import('./config-mutation.js');
    expect(parseConfigValue('false')).toBe(false);
  });

  it('converts numeric strings to numbers', async () => {
    const { parseConfigValue } = await import('./config-mutation.js');
    expect(parseConfigValue('42')).toBe(42);
    expect(parseConfigValue('3.14')).toBe(3.14);
  });

  it('parses JSON arrays', async () => {
    const { parseConfigValue } = await import('./config-mutation.js');
    expect(parseConfigValue('["a","b"]')).toEqual(['a', 'b']);
  });

  it('parses JSON objects', async () => {
    const { parseConfigValue } = await import('./config-mutation.js');
    expect(parseConfigValue('{"key":"val"}')).toEqual({ key: 'val' });
  });

  it('preserves plain strings', async () => {
    const { parseConfigValue } = await import('./config-mutation.js');
    expect(parseConfigValue('hello')).toBe('hello');
  });

  it('preserves empty string as empty string', async () => {
    const { parseConfigValue } = await import('./config-mutation.js');
    expect(parseConfigValue('')).toBe('');
  });
});

// ─── getConfigValueDomainError ────────────────────────────────────────────

describe('project-contained mutation success paths', () => {
  it('configSet updates one nested key, preserves siblings, and masks secret responses', async () => {
    const { configSet } = await import('./config-mutation.js');
    const configPath = join(tmpDir, '.planning', 'config.json');
    await writeFile(configPath, JSON.stringify({
      workflow: { research: true },
      brave_search: 'OLD-KEY-1234567890',
    }));

    await configSet(['workflow.auto_advance', 'true'], tmpDir);
    const secretResult = await configSet(['brave_search', 'NEW-KEY-abcdef9999'], tmpDir);

    expect(secretResult.data).toMatchObject({
      value: '****9999',
      previousValue: '****7890',
    });
    const stored = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(stored.workflow).toEqual({ research: true, auto_advance: true });
    expect(stored.brave_search).toBe('NEW-KEY-abcdef9999');
  });

  it('configSetModelProfile normalizes the profile and preserves sibling settings', async () => {
    const { configSetModelProfile } = await import('./config-mutation.js');
    const configPath = join(tmpDir, '.planning', 'config.json');
    await writeFile(configPath, JSON.stringify({ model_profile: 'balanced', commit_docs: false }));

    const result = await configSetModelProfile([' Quality '], tmpDir);

    expect(result.data).toMatchObject({ updated: true, profile: 'quality', previousProfile: 'balanced' });
    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toMatchObject({
      model_profile: 'quality',
      commit_docs: false,
    });
  });

  it('configNewProject creates a validated config once and is idempotent', async () => {
    const { configNewProject } = await import('./config-mutation.js');
    const configPath = join(tmpDir, '.planning', 'config.json');

    const created = await configNewProject([
      JSON.stringify({ model_profile: 'quality', workflow: { auto_advance: true } }),
    ], tmpDir);
    const second = await configNewProject([JSON.stringify({ model_profile: 'budget' })], tmpDir);

    expect(created.data).toMatchObject({ created: true });
    expect(second.data).toEqual({ created: false, reason: 'already_exists' });
    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toMatchObject({
      model_profile: 'quality',
      workflow: { research: true, auto_advance: true },
    });
  });

  it('configEnsureSection creates a missing section and preserves it on repeat calls', async () => {
    const { configEnsureSection } = await import('./config-mutation.js');
    const configPath = join(tmpDir, '.planning', 'config.json');
    await writeFile(configPath, JSON.stringify({ model_profile: 'balanced' }));

    await configEnsureSection(['workflow'], tmpDir);
    await writeFile(configPath, JSON.stringify({
      ...JSON.parse(await readFile(configPath, 'utf-8')),
      workflow: { research: true },
    }));
    await configEnsureSection(['workflow'], tmpDir);

    expect(JSON.parse(await readFile(configPath, 'utf-8')).workflow).toEqual({ research: true });
  });
});

describe('CJS-compatible planning lock and identity guarantees', () => {
  it('serializes concurrent sibling updates through one planning lock', async () => {
    const { configSet } = await import('./config-mutation.js');
    const configPath = join(tmpDir, '.planning', 'config.json');
    await writeFile(configPath, JSON.stringify({ workflow: { research: true } }));

    await Promise.all([
      configSet(['workflow.auto_advance', 'true'], tmpDir),
      configSet(['workflow.plan_check', 'false'], tmpDir),
      configSet(['workflow.verifier', 'false'], tmpDir),
    ]);

    expect(JSON.parse(await readFile(configPath, 'utf-8')).workflow).toEqual({
      research: true,
      auto_advance: true,
      plan_check: false,
      verifier: false,
    });
  });

  it('waits for an actual CJS planning lock before mutating config', async () => {
    const { configSet } = await import('./config-mutation.js');
    const configPath = join(tmpDir, '.planning', 'config.json');
    const lockPath = join(tmpDir, '.planning', '.lock');
    const workspaceModule = join(
      process.cwd(),
      '..',
      'get-shit-done',
      'bin',
      'lib',
      'planning-workspace.cjs',
    );
    await writeFile(configPath, '{}');
    const child = spawn(process.execPath, [
      '-e',
      "const { withPlanningLock } = require(process.argv[1]); withPlanningLock(process.argv[2], () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400));",
      workspaceModule,
      tmpDir,
    ], { stdio: 'ignore' });
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await lstat(lockPath).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await lstat(lockPath).then(() => true, () => false)).toBe(true);

      const started = Date.now();
      await configSet(['commit_docs', 'true'], tmpDir);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      expect(JSON.parse(await readFile(configPath, 'utf-8')).commit_docs).toBe(true);
    } finally {
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }
  });

  it('does not delete or bypass a fresh active planning lock', async () => {
    const { configSet } = await import('./config-mutation.js');
    const configPath = join(tmpDir, '.planning', 'config.json');
    const lockPath = join(tmpDir, '.planning', '.lock');
    const lockContent = JSON.stringify({ pid: process.pid, cwd: tmpDir, acquired: new Date().toISOString() });
    await writeFile(configPath, '{}');
    await writeFile(lockPath, lockContent, { flag: 'wx' });

    let settled = false;
    const mutation = configSet(['commit_docs', 'true'], tmpDir).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(settled).toBe(false);
    expect(await readFile(lockPath, 'utf-8')).toBe(lockContent);
    expect(JSON.parse(await readFile(configPath, 'utf-8')).commit_docs).toBeUndefined();

    await rm(lockPath);
    await mutation;
  });

  it('rejects a same-path real planning-directory replacement after locking', async () => {
    const { configSet } = await import('./config-mutation.js');
    const outsideDir = await mkdtemp(join(tmpdir(), 'gsd-cfgmut-real-parent-swap-'));
    const planningDir = join(tmpDir, '.planning');
    const configPath = join(planningDir, 'config.json');
    const displacedDir = join(outsideDir, 'displaced-planning');
    let swapExecuted = false;
    try {
      await writeFile(configPath, JSON.stringify({ model_profile: 'balanced' }));
      spawnBoundaryHook.callback = () => {
        spawnBoundaryHook.callback = undefined;
        renameSync(planningDir, displacedDir);
        mkdirSync(planningDir);
        writeFileSync(configPath, JSON.stringify({ model_profile: 'replacement-sentinel' }));
        swapExecuted = true;
      };

      const result = await configSet(['model_profile', 'quality'], tmpDir)
        .then(() => undefined, (err: unknown) => err);

      expect(swapExecuted).toBe(true);
      expect(result).toBeInstanceOf(GSDError);
      expect(JSON.parse(await readFile(configPath, 'utf-8')).model_profile)
        .toBe('replacement-sentinel');
    } finally {
      spawnBoundaryHook.callback = undefined;
      await rm(planningDir, { recursive: true, force: true });
      await rename(displacedDir, planningDir).catch(() => undefined);
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('configNewProject recursive defaults merge', () => {
  it('preserves deep global-default siblings when user choices override one nested key', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'gsd-cfgmut-deep-defaults-'));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = fakeHome;
      await mkdir(join(fakeHome, '.gsd'));
      await writeFile(join(fakeHome, '.gsd', 'defaults.json'), JSON.stringify({
        dynamic_routing: {
          enabled: true,
          tier_models: { light: 'haiku', standard: 'sonnet' },
        },
      }));
      const { configNewProject } = await import('./config-mutation.js');

      await configNewProject([JSON.stringify({
        dynamic_routing: { tier_models: { heavy: 'opus' } },
      })], tmpDir);

      expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')).dynamic_routing)
        .toEqual({
          enabled: true,
          tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('getConfigValueDomainError accepted domains', () => {
  it('accepts all supported domain values without creating config.json', async () => {
    const { getConfigValueDomainError } = await import('./config-schema.js');
    const { VALID_PROFILES } = await import('./config-query.js');
    const accepted: Array<[string, unknown]> = [
      ...VALID_PROFILES.map((profile) => ['model_profile', profile] as [string, unknown]),
      ['workflow.drift_action', 'warn'],
      ['workflow.drift_action', 'auto-remap'],
      ['workflow.drift_threshold', 1],
      ['workflow.drift_threshold', 42],
      ['workflow.post_planning_gaps', true],
      ['workflow.post_planning_gaps', false],
      ['workflow.security_enforcement', true],
      ['workflow.security_enforcement', false],
      ['workflow.security_asvs_level', 1],
      ['workflow.security_asvs_level', 2],
      ['workflow.security_asvs_level', 3],
      ['workflow.security_block_on', 'high'],
      ['workflow.security_block_on', 'medium'],
      ['workflow.security_block_on', 'low'],
    ];

    for (const [key, value] of accepted) {
      expect(getConfigValueDomainError(key, value), `${key}=${String(value)}`).toBeUndefined();
    }
    await expect(readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ─── mutation availability ───────────────────────────────────────────────

// ─── configSet context validation ─────────────────────────────────────────

describe('configSet context validation (D8)', () => {
  it('rejects invalid context values', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(join(tmpDir, '.planning', 'config.json'), '{}');

    await expect(configSet(['context', 'invalid'], tmpDir)).rejects.toThrow(/Invalid context value/);
  });

  it('writes valid context values', async () => {
    const { configSet } = await import('./config-mutation.js');

    for (const ctx of ['dev', 'research', 'review']) {
      await writeFile(join(tmpDir, '.planning', 'config.json'), '{}');
      await configSet(['context', ctx], tmpDir);
      expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')).context).toBe(ctx);
    }
  });

  it.each([
    {
      key: 'workflow.drift_action',
      value: 'sometimes',
      initial: { workflow: { drift_action: 'warn' } },
      expectedStored: 'warn',
      message: /Invalid workflow\.drift_action/,
    },
    {
      key: 'workflow.drift_threshold',
      value: 'many',
      initial: { workflow: { drift_threshold: 5 } },
      expectedStored: 5,
      message: /Invalid workflow\.drift_threshold/,
    },
    {
      key: 'workflow.drift_threshold',
      value: '0',
      initial: { workflow: { drift_threshold: 5 } },
      expectedStored: 5,
      message: /Invalid workflow\.drift_threshold/,
    },
    {
      key: 'workflow.drift_threshold',
      value: '1.5',
      initial: { workflow: { drift_threshold: 5 } },
      expectedStored: 5,
      message: /Invalid workflow\.drift_threshold/,
    },
    {
      key: 'workflow.post_planning_gaps',
      value: 'yes',
      initial: { workflow: { post_planning_gaps: false } },
      expectedStored: false,
      message: /Invalid workflow\.post_planning_gaps/,
    },
  ])('rejects CJS-invalid $key=$value before writing config.json', async ({
    key,
    value,
    initial,
    expectedStored,
    message,
  }) => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(join(tmpDir, '.planning', 'config.json'), JSON.stringify(initial));

    await expect(configSet([key, value], tmpDir)).rejects.toThrow(message);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    const [section, field] = key.split('.');
    expect(raw[section][field]).toBe(expectedStored);
  });

  it('rejects an invalid model_profile before writing config.json', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
    );

    const result = await configSet(['model_profile', 'invalid_profile'], tmpDir)
      .then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect.soft(raw.model_profile).toBe('balanced');
  });

  it.each([
    ['workflow.security_enforcement', '0', true],
    ['workflow.security_asvs_level', '0', 2],
    ['workflow.security_block_on', 'none', 'high'],
  ])('rejects invalid security policy %s=%s without mutation', async (key, value, initialValue) => {
    const { configSet } = await import('./config-mutation.js');
    const field = key.split('.')[1];
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { [field]: initialValue } }),
    );

    const result = await configSet([key, value], tmpDir).then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect.soft(raw.workflow[field]).toBe(initialValue);
  });

  it.each([
    ['workflow.security_enforcement', 'true'],
    ['workflow.security_asvs_level', '2'],
    ['workflow.security_block_on', 'high'],
  ])('writes representative security policy %s=%s', async (key, value) => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(join(tmpDir, '.planning', 'config.json'), '{}');

    await configSet([key, value], tmpDir);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    const expected = value === 'true' ? true : value === '2' ? 2 : value;
    expect(raw.workflow?.[key.split('.')[1]]).toBe(expected);
  });
});

// ─── configNewProject global defaults ─────────────────────────────────────

describe('configNewProject global defaults (D11)', () => {
  it('creates a config from standard defaults', async () => {
    const { configNewProject } = await import('./config-mutation.js');
    await configNewProject([], tmpDir);
    expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')).model_profile)
      .toBe('balanced');
  });
});

// ─── configNewProject nested globalDefaults merging ───────────────────────

describe('configNewProject nested globalDefaults merging (fix #2673)', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'gsd-fakehome-'));
    await mkdir(join(fakeHome, '.gsd'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('preserves nested workflow and git globalDefaults', async () => {
    await writeFile(
      join(fakeHome, '.gsd', 'defaults.json'),
      JSON.stringify({
        workflow: { auto_advance: true, discuss_mode: 'skip' },
        git: { branching_strategy: 'milestone' },
      }),
    );

    const { configNewProject } = await import('./config-mutation.js');
    await configNewProject([], tmpDir);
    const config = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(config.workflow).toMatchObject({ auto_advance: true, discuss_mode: 'skip', research: true });
    expect(config.git).toMatchObject({
      branching_strategy: 'milestone',
      phase_branch_template: 'gsd/phase-{phase}-{slug}',
    });
  });

  it('lets user choices override nested globalDefaults', async () => {
    await writeFile(
      join(fakeHome, '.gsd', 'defaults.json'),
      JSON.stringify({
        workflow: { auto_advance: true },
      }),
    );

    const { configNewProject } = await import('./config-mutation.js');
    const choices = JSON.stringify({ workflow: { auto_advance: false } });
    await configNewProject([choices], tmpDir);
    expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')).workflow.auto_advance)
      .toBe(false);
  });

  it('preserves hooks, agent skills, and features globalDefaults', async () => {
    await writeFile(
      join(fakeHome, '.gsd', 'defaults.json'),
      JSON.stringify({
        hooks: { context_warnings: false },
        agent_skills: { my_skill: true },
        features: { beta_feature: true },
      }),
    );

    const { configNewProject } = await import('./config-mutation.js');
    await configNewProject([], tmpDir);
    const config = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(config.hooks.context_warnings).toBe(false);
    expect(config.agent_skills.my_skill).toBe(true);
    expect(config.features.beta_feature).toBe(true);
  });

  it('rejects unknown keys from globalDefaults before creating config.json', async () => {
    await writeFile(
      join(fakeHome, '.gsd', 'defaults.json'),
      JSON.stringify({ unexpected_policy: true }),
    );

    const { configNewProject } = await import('./config-mutation.js');
    await expect(configNewProject([], tmpDir)).rejects.toThrow(/Unknown config key/);
    await expect(readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects prototype-reserved dynamic keys from globalDefaults without polluting prototypes', async () => {
    await writeFile(
      join(fakeHome, '.gsd', 'defaults.json'),
      '{"model_profile_overrides":{"constructor":{"opus":"owned"}}}',
    );

    const { configNewProject } = await import('./config-mutation.js');
    await expect(configNewProject([], tmpDir)).rejects.toThrow(/Unknown config key/);
    expect(({} as Record<string, unknown>).opus).toBeUndefined();
    await expect(readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['security_enforcement', 0],
    ['security_asvs_level', 0],
    ['security_block_on', 'none'],
  ])('rejects invalid security policy workflow.%s=%s in global defaults before config creation', async (
    field,
    value,
  ) => {
    await writeFile(
      join(fakeHome, '.gsd', 'defaults.json'),
      JSON.stringify({ workflow: { [field]: value } }),
    );
    const { configNewProject } = await import('./config-mutation.js');

    const result = await configNewProject([], tmpDir).then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    const configResult = await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')
      .then(() => undefined, (err: unknown) => err);
    expect.soft(configResult).toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['model_profile=invalid_profile', { model_profile: 'invalid_profile' }],
    ['workflow.drift_action=sometimes', { workflow: { drift_action: 'sometimes' } }],
    ['workflow.drift_threshold=0', { workflow: { drift_threshold: 0 } }],
    ['workflow.drift_threshold=1.5', { workflow: { drift_threshold: 1.5 } }],
    ['workflow.post_planning_gaps=yes', { workflow: { post_planning_gaps: 'yes' } }],
  ])('rejects invalid %s in global defaults before config creation', async (_caseName, defaults) => {
    await writeFile(join(fakeHome, '.gsd', 'defaults.json'), JSON.stringify(defaults));
    const { configNewProject } = await import('./config-mutation.js');

    const result = await configNewProject([], tmpDir).then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    const configResult = await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')
      .then(() => undefined, (err: unknown) => err);
    expect.soft(configResult).toMatchObject({ code: 'ENOENT' });
  });

  it('writes representative value-domain defaults', async () => {
    const defaults = {
      model_profile: 'quality',
      workflow: { drift_action: 'warn', drift_threshold: 1, post_planning_gaps: true },
    };
    await writeFile(join(fakeHome, '.gsd', 'defaults.json'), JSON.stringify(defaults));
    const { configNewProject } = await import('./config-mutation.js');

    await configNewProject([], tmpDir);
    expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')))
      .toMatchObject(defaults);
  });
});

// ─── configSet ─────────────────────────────────────────────────────────────

describe('configSet', () => {
  it('writes a validated value', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
    );
    await configSet(['model_profile', 'quality'], tmpDir);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.model_profile).toBe('quality');
  });

  it('writes nested dot-notation keys without losing siblings', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { research: true } }),
    );
    await configSet(['workflow.auto_advance', 'true'], tmpDir);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.workflow.auto_advance).toBe(true);
    expect(raw.workflow.research).toBe(true);
  });

  it('rejects invalid key with GSDError', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({}),
    );
    await expect(configSet(['totally_bogus_key', 'value'], tmpDir)).rejects.toThrow(GSDError);
  });

  it('rejects prototype-reserved dynamic key paths without polluting prototypes', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({}),
    );

    await expect(configSet(['model_profile_overrides.__proto__.opus', 'owned'], tmpDir))
      .rejects.toThrow(/Unknown config key/);

    expect(({} as Record<string, unknown>).opus).toBeUndefined();
    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw).toEqual({});
  });

  it('rejects a missing value before writing config.json', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
    );

    await expect(configSet(['model_profile'], tmpDir)).rejects.toThrow(/Usage: config-set/);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.model_profile).toBe('balanced');
  });

  it('coerces values through parseConfigValue', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({}),
    );
    await configSet(['commit_docs', 'true'], tmpDir);
    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.commit_docs).toBe(true);
  });

  it('rejects invalid direct SDK workstream names before config-set can write outside the project', async () => {
    const { createRegistry } = await import('./index.js');
    const escapeName = `${basename(tmpDir)}-escape`;
    const escapeDir = join(tmpDir, '..', escapeName);
    try {
      await mkdir(escapeDir, { recursive: true });

      const result = await createRegistry()
        .dispatch('config-set', ['model_profile', 'quality'], tmpDir, `../../../${escapeName}`)
        .then(() => 'resolved', (err: unknown) => err);

      expect(result).toBeInstanceOf(GSDError);
      expect((result as GSDError).classification).toBe(ErrorClassification.Validation);
      await expect(readFile(join(escapeDir, 'config.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(escapeDir, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked workstream before config-set can write outside the project', async () => {
    const { configSet } = await import('./config-mutation.js');
    const outsideDir = await mkdtemp(join(tmpdir(), 'gsd-cfgmut-outside-'));
    const sentinelPath = join(outsideDir, 'sentinel.txt');
    try {
      await mkdir(join(tmpDir, '.planning', 'workstreams'), { recursive: true });
      await writeFile(sentinelPath, 'unchanged');
      await symlink(outsideDir, join(tmpDir, '.planning', 'workstreams', 'safe-stream'), 'dir');

      const result = await configSet(['model_profile', 'quality'], tmpDir, 'safe-stream')
        .then(() => undefined, (err: unknown) => err);

      expect.soft(result).toBeInstanceOf(GSDError);
      if (result instanceof GSDError) {
        expect.soft(result.classification).toBe(ErrorClassification.Validation);
      }
      const configResult = await readFile(join(outsideDir, 'config.json'), 'utf-8')
        .then(() => undefined, (err: unknown) => err);
      expect.soft(configResult).toMatchObject({ code: 'ENOENT' });
      expect.soft(await readFile(sentinelPath, 'utf-8')).toBe('unchanged');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a workstream parent swap before the anchored child writes', async () => {
    const { configSet } = await import('./config-mutation.js');
    const outsideDir = await mkdtemp(join(tmpdir(), 'gsd-cfgmut-parent-swap-outside-'));
    const workstreamDir = join(tmpDir, '.planning', 'workstreams', 'swap-stream');
    const configPath = join(workstreamDir, 'config.json');
    const displacedDir = join(outsideDir, 'replacement-workstream');
    let swapExecuted = false;
    try {
      await mkdir(workstreamDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ model_profile: 'balanced' }));

      spawnBoundaryHook.callback = () => {
        spawnBoundaryHook.callback = undefined;
        renameSync(workstreamDir, displacedDir);
        symlinkSync(displacedDir, workstreamDir, 'dir');
        swapExecuted = true;
      };

      const result = await configSet(['model_profile', 'quality'], tmpDir, 'swap-stream')
        .then(() => undefined, (err: unknown) => err);

      expect.soft(swapExecuted).toBe(true);
      expect.soft(result).toBeInstanceOf(GSDError);
      expect.soft(JSON.parse(await readFile(join(displacedDir, 'config.json'), 'utf-8')).model_profile)
        .toBe('balanced');
    } finally {
      spawnBoundaryHook.callback = undefined;
      await rm(workstreamDir, { recursive: true, force: true });
      await rename(displacedDir, workstreamDir).catch(() => undefined);
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

// ─── configSetModelProfile ─────────────────────────────────────────────────

describe('configSetModelProfile', () => {
  it('writes a valid profile', async () => {
    const { configSetModelProfile } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
    );
    await configSetModelProfile(['quality'], tmpDir);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.model_profile).toBe('quality');
  });

  it('rejects invalid profile with GSDError', async () => {
    const { configSetModelProfile } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({}),
    );
    await expect(configSetModelProfile(['invalid_profile'], tmpDir)).rejects.toThrow(GSDError);
  });

  it('normalizes a profile before writing', async () => {
    const { configSetModelProfile } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({}),
    );
    await configSetModelProfile(['Quality'], tmpDir);
    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.model_profile).toBe('quality');
  });
});

// ─── configNewProject ──────────────────────────────────────────────────────

describe('configNewProject', () => {
  it('creates config.json from defaults', async () => {
    const { configNewProject } = await import('./config-mutation.js');
    await configNewProject([], tmpDir);
    expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')).model_profile)
      .toBe('balanced');
  });

  it('merges validated user choices', async () => {
    const { configNewProject } = await import('./config-mutation.js');
    const choices = JSON.stringify({ model_profile: 'quality', commit_docs: true });
    await configNewProject([choices], tmpDir);
    expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')))
      .toMatchObject({ model_profile: 'quality', commit_docs: true });
  });

  it.each([
    ['security_enforcement', 0],
    ['security_asvs_level', 0],
    ['security_block_on', 'none'],
  ])('rejects invalid security policy workflow.%s=%s in user choices before config creation', async (
    field,
    value,
  ) => {
    const { configNewProject } = await import('./config-mutation.js');
    const choices = JSON.stringify({ workflow: { [field]: value } });

    const result = await configNewProject([choices], tmpDir).then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    const configResult = await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')
      .then(() => undefined, (err: unknown) => err);
    expect.soft(configResult).toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['model_profile=invalid_profile', { model_profile: 'invalid_profile' }],
    ['workflow.drift_action=sometimes', { workflow: { drift_action: 'sometimes' } }],
    ['workflow.drift_threshold=0', { workflow: { drift_threshold: 0 } }],
    ['workflow.drift_threshold=1.5', { workflow: { drift_threshold: 1.5 } }],
    ['workflow.post_planning_gaps=yes', { workflow: { post_planning_gaps: 'yes' } }],
  ])('rejects invalid %s in user choices before config creation', async (_caseName, choices) => {
    const { configNewProject } = await import('./config-mutation.js');

    const result = await configNewProject([JSON.stringify(choices)], tmpDir)
      .then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    const configResult = await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')
      .then(() => undefined, (err: unknown) => err);
    expect.soft(configResult).toMatchObject({ code: 'ENOENT' });
  });

  it('writes representative value-domain user choices', async () => {
    const choices = {
      model_profile: 'quality',
      workflow: { drift_action: 'warn', drift_threshold: 1, post_planning_gaps: true },
    };
    const { configNewProject } = await import('./config-mutation.js');

    await configNewProject([JSON.stringify(choices)], tmpDir);
    expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')))
      .toMatchObject(choices);
  });

  it('writes representative security policy values', async () => {
    const { configNewProject } = await import('./config-mutation.js');
    const choices = {
      workflow: {
        security_enforcement: true,
        security_asvs_level: 2,
        security_block_on: 'high',
      },
    };

    await configNewProject([JSON.stringify(choices)], tmpDir);
    expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')))
      .toMatchObject(choices);
  });

  it('rejects unknown keys in user choices before creating config.json', async () => {
    const { configNewProject } = await import('./config-mutation.js');

    await expect(configNewProject([JSON.stringify({ unexpected_policy: true })], tmpDir))
      .rejects.toThrow(/Unknown config key/);
    await expect(readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects prototype-reserved nested user choice keys without polluting prototypes', async () => {
    const { configNewProject } = await import('./config-mutation.js');

    await expect(configNewProject(['{"model_profile_overrides":{"__proto__":{"opus":"owned"}}}'], tmpDir))
      .rejects.toThrow(/Unknown config key/);

    expect(({} as Record<string, unknown>).opus).toBeUndefined();
    await expect(readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    '{"model_overrides":{"bad/slash":{}}}',
    '{"model_profile_overrides":{"__proto__":{}}}',
    '{"model_profile_overrides":{"custom":{}}}',
  ])('rejects invalid empty object dynamic branches in user choices: %s', async (choices) => {
    const { configNewProject } = await import('./config-mutation.js');

    await expect(configNewProject([choices], tmpDir)).rejects.toThrow(/Unknown config key/);
    await expect(readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed top-level section values in user choices', async () => {
    const { configNewProject } = await import('./config-mutation.js');

    await expect(configNewProject([JSON.stringify({ workflow: false })], tmpDir))
      .rejects.toThrow(/Invalid config section/);
    await expect(readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a config whose defaults remain readable through config-get', async () => {
    const { configNewProject } = await import('./config-mutation.js');
    const { configGet } = await import('./config-query.js');
    await configNewProject([], tmpDir);
    expect((await configGet(['model_profile'], tmpDir)).data).toBe('balanced');
  });

  it('does not overwrite an existing config', async () => {
    const { configNewProject } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality' }),
    );
    expect((await configNewProject([], tmpDir)).data).toEqual({
      created: false,
      reason: 'already_exists',
    });
    expect(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'))
      .toBe(JSON.stringify({ model_profile: 'quality' }));
  });
});

// ─── configEnsureSection ───────────────────────────────────────────────────

describe('configEnsureSection', () => {
  it('creates a missing section', async () => {
    const { configEnsureSection } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
    );
    await configEnsureSection(['workflow'], tmpDir);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.workflow).toEqual({});
  });

  it('preserves an existing section idempotently', async () => {
    const { configEnsureSection } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { research: true } }),
    );
    await configEnsureSection(['workflow'], tmpDir);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.workflow).toEqual({ research: true });
  });

  it('rejects unknown top-level sections before writing config.json', async () => {
    const { configEnsureSection } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
    );

    await expect(configEnsureSection(['unexpected_policy'], tmpDir)).rejects.toThrow(/Unknown config section/);

    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.unexpected_policy).toBeUndefined();
  });
});

describe('config mutation workstream path containment matrix', () => {
  it.each([
    { name: 'configSet', args: ['model_profile', 'quality'], initial: { model_profile: 'balanced' } },
    { name: 'configSetModelProfile', args: ['quality'], initial: { model_profile: 'balanced' } },
    { name: 'configNewProject', args: [], initial: null },
    { name: 'configEnsureSection', args: ['workflow'], initial: { model_profile: 'balanced' } },
  ] as const)('$name rejects an in-project symlink redirect outside the workstream tree', async ({
    name,
    args,
    initial,
  }) => {
    const mutations = await import('./config-mutation.js');
    const workstream = 'redirected-stream';
    const redirectDir = join(tmpDir, '.planning', 'redirected-config');
    const redirectedConfig = join(redirectDir, 'config.json');
    await mkdir(join(tmpDir, '.planning', 'workstreams'), { recursive: true });
    await mkdir(redirectDir, { recursive: true });
    const original = initial === null ? undefined : JSON.stringify(initial);
    if (original !== undefined) await writeFile(redirectedConfig, original);
    await symlink(redirectDir, join(tmpDir, '.planning', 'workstreams', workstream), 'dir');

    const result = await mutations[name]([...args], tmpDir, workstream)
      .then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    if (original === undefined) {
      const configResult = await readFile(redirectedConfig, 'utf-8')
        .then(() => undefined, (err: unknown) => err);
      expect.soft(configResult).toMatchObject({ code: 'ENOENT' });
    } else {
      expect.soft(await readFile(redirectedConfig, 'utf-8')).toBe(original);
    }
  });

  it('writes a legitimate contained workstream config', async () => {
    const { configSet } = await import('./config-mutation.js');
    const workstreamDir = join(tmpDir, '.planning', 'workstreams', 'existing-stream');
    await mkdir(workstreamDir, { recursive: true });
    await writeFile(join(workstreamDir, 'config.json'), JSON.stringify({ model_profile: 'balanced' }));

    await configSet(['model_profile', 'quality'], tmpDir, 'existing-stream');
    const raw = JSON.parse(await readFile(join(workstreamDir, 'config.json'), 'utf-8'));
    expect(raw.model_profile).toBe('quality');
  });

  it('does not follow a pre-planted predictable temp symlink in a legitimate workstream', async () => {
    const { configSet } = await import('./config-mutation.js');
    const workstreamDir = join(tmpDir, '.planning', 'workstreams', 'existing-stream');
    const configPath = join(workstreamDir, 'config.json');
    const outsideDir = await mkdtemp(join(tmpdir(), 'gsd-cfgmut-sentinel-'));
    const sentinelPath = join(outsideDir, 'sentinel.txt');
    try {
      await mkdir(workstreamDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ model_profile: 'balanced' }));
      await writeFile(sentinelPath, 'unchanged');
      await symlink(sentinelPath, `${configPath}.tmp.${process.pid}`, 'file');

      await configSet(['model_profile', 'quality'], tmpDir, 'existing-stream');
      expect.soft(await readFile(sentinelPath, 'utf-8')).toBe('unchanged');
      const configStat = await lstat(configPath);
      expect.soft(configStat.isFile()).toBe(true);
      expect.soft(configStat.isSymbolicLink()).toBe(false);
      expect.soft(JSON.parse(await readFile(configPath, 'utf-8')).model_profile).toBe('quality');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'configSet', args: ['model_profile', 'quality'], initial: { model_profile: 'redirect-sentinel' } },
    { name: 'configSetModelProfile', args: ['quality'], initial: { model_profile: 'redirect-sentinel' } },
    { name: 'configNewProject', args: [], initial: null },
    { name: 'configEnsureSection', args: ['workflow'], initial: { model_profile: 'redirect-sentinel' } },
  ] as const)('$name rejects a symlinked workstreams ancestor redirected in-project', async ({
    name,
    args,
    initial,
  }) => {
    const mutations = await import('./config-mutation.js');
    const redirectDir = join(tmpDir, '.planning', 'redirected-workstreams');
    const redirectedWorkstream = join(redirectDir, 'ancestor-stream');
    const redirectedConfig = join(redirectedWorkstream, 'config.json');
    const original = initial === null ? undefined : JSON.stringify(initial);
    await mkdir(redirectedWorkstream, { recursive: true });
    if (original !== undefined) await writeFile(redirectedConfig, original);
    await symlink(redirectDir, join(tmpDir, '.planning', 'workstreams'), 'dir');

    const result = await mutations[name]([...args], tmpDir, 'ancestor-stream')
      .then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    if (original === undefined) {
      const configResult = await readFile(redirectedConfig, 'utf-8')
        .then(() => undefined, (err: unknown) => err);
      expect.soft(configResult).toMatchObject({ code: 'ENOENT' });
    } else {
      expect.soft(await readFile(redirectedConfig, 'utf-8')).toBe(original);
    }
  });

  it('rejects configNewProject when a new workstream commit cannot be anchored', async () => {
    const { configNewProject } = await import('./config-mutation.js');

    const result = await configNewProject([], tmpDir, 'new-stream')
      .then(() => undefined, (err: unknown) => err);

    expect.soft(result).toBeInstanceOf(GSDError);
    if (result instanceof GSDError) {
      expect.soft(result.classification).toBe(ErrorClassification.Validation);
    }
    await expect(readFile(
      join(tmpDir, '.planning', 'workstreams', 'new-stream', 'config.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('config mutation root planning path containment', () => {
  it('configNewProject fails closed without creating a missing root .planning directory', async () => {
    const { configNewProject } = await import('./config-mutation.js');
    await rm(join(tmpDir, '.planning'), { recursive: true, force: true });

    const result = await configNewProject([], tmpDir).then(() => undefined, (err: unknown) => err);

    expect(result).toBeInstanceOf(GSDError);
    expect((result as GSDError).classification).toBe(ErrorClassification.Validation);
    await expect(lstat(join(tmpDir, '.planning'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { name: 'configSet', args: ['model_profile', 'quality'], initial: { model_profile: 'redirect-sentinel' } },
    { name: 'configSetModelProfile', args: ['quality'], initial: { model_profile: 'redirect-sentinel' } },
    { name: 'configNewProject', args: [], initial: null },
    { name: 'configEnsureSection', args: ['workflow'], initial: { model_profile: 'redirect-sentinel' } },
  ] as const)('$name rejects a root .planning symlink outside the project', async ({
    name,
    args,
    initial,
  }) => {
    const mutations = await import('./config-mutation.js');
    const outsideDir = await mkdtemp(join(tmpdir(), 'gsd-cfgmut-root-planning-'));
    const outsideConfig = join(outsideDir, 'config.json');
    const original = initial === null ? undefined : JSON.stringify(initial);
    try {
      await rm(join(tmpDir, '.planning'), { recursive: true, force: true });
      if (original !== undefined) await writeFile(outsideConfig, original);
      await symlink(outsideDir, join(tmpDir, '.planning'), 'dir');

      const result = await mutations[name]([...args], tmpDir)
        .then(() => undefined, (err: unknown) => err);

      expect.soft(result).toBeInstanceOf(GSDError);
      if (result instanceof GSDError) {
        expect.soft(result.classification).toBe(ErrorClassification.Validation);
      }
      if (original === undefined) {
        const configResult = await readFile(outsideConfig, 'utf-8')
          .then(() => undefined, (err: unknown) => err);
        expect.soft(configResult).toMatchObject({ code: 'ENOENT' });
      } else {
        expect.soft(await readFile(outsideConfig, 'utf-8')).toBe(original);
      }
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'configSet', args: ['model_profile', 'quality'], initial: { model_profile: 'root-sentinel' } },
    { name: 'configSetModelProfile', args: ['quality'], initial: { model_profile: 'root-sentinel' } },
    { name: 'configNewProject', args: [], initial: null },
    { name: 'configEnsureSection', args: ['workflow'], initial: { model_profile: 'root-sentinel' } },
  ] as const)('$name rejects a root .planning swap at the child-write boundary', async ({
    name,
    args,
    initial,
  }) => {
    const mutations = await import('./config-mutation.js');
    const outsideDir = await mkdtemp(join(tmpdir(), 'gsd-cfgmut-root-parent-swap-'));
    const planningDir = join(tmpDir, '.planning');
    const configPath = join(planningDir, 'config.json');
    const displacedDir = join(outsideDir, 'displaced-planning');
    const outsideConfig = join(displacedDir, 'config.json');
    const original = initial === null ? undefined : JSON.stringify(initial);
    let swapExecuted = false;
    try {
      if (original !== undefined) await writeFile(configPath, original);

      spawnBoundaryHook.callback = () => {
        spawnBoundaryHook.callback = undefined;
        renameSync(planningDir, displacedDir);
        symlinkSync(displacedDir, planningDir, 'dir');
        swapExecuted = true;
      };

      const result = await mutations[name]([...args], tmpDir)
        .then(() => undefined, (err: unknown) => err);

      expect.soft(swapExecuted).toBe(true);
      expect.soft(result).toBeInstanceOf(GSDError);
      if (result instanceof GSDError) {
        expect.soft(result.classification).toBe(ErrorClassification.Validation);
      }
      if (original === undefined) {
        await expect(readFile(outsideConfig, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect.soft(await readFile(outsideConfig, 'utf-8')).toBe(original);
      }
    } finally {
      spawnBoundaryHook.callback = undefined;
      await rm(planningDir, { recursive: true, force: true });
      await rename(displacedDir, planningDir).catch(() => undefined);
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

// ─── #2997: Secret mutation boundary ──────────────────────────────────────

describe('configSet secret masking (#2997)', () => {
  it('masks secret response values while storing usable plaintext', async () => {
    const { configSet } = await import('./config-mutation.js');
    const apiKey = ['BSA', '1234567890abcdef'].join('-');
    const result = await configSet(['brave_search', apiKey], tmpDir);
    expect((result.data as { value: string }).value).toBe('****cdef');
    expect(JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8')).brave_search)
      .toBe(apiKey);
  });

  it('masks both current and previous secret response values', async () => {
    const { configSet } = await import('./config-mutation.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ brave_search: 'OLD-KEY-1234567890' }),
    );
    const result = await configSet(['brave_search', 'NEW-KEY-abcdef9999'], tmpDir);
    expect(result.data).toMatchObject({ value: '****9999', previousValue: '****7890' });
    const raw = JSON.parse(await readFile(join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    expect(raw.brave_search).toBe('NEW-KEY-abcdef9999');
  });

  it('does not mask non-secret values', async () => {
    const { configSet } = await import('./config-mutation.js');
    expect((await configSet(['model_profile', 'quality'], tmpDir)).data)
      .toMatchObject({ value: 'quality' });
  });

  it('fully masks short secret response values', async () => {
    const { configSet } = await import('./config-mutation.js');
    expect((await configSet(['firecrawl', 'short'], tmpDir)).data)
      .toMatchObject({ value: '****' });
  });

  it('renders empty secret response values as unset', async () => {
    const { configSet } = await import('./config-mutation.js');
    expect((await configSet(['exa_search', ''], tmpDir)).data)
      .toMatchObject({ value: '(unset)' });
  });
});
