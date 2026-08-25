/**
 * Config mutation handlers — project-contained writes for .planning/config.json.
 *
 * Ported from get-shit-done/bin/lib/config.cjs.
 * Provides config-set (with key validation and value coercion),
 * config-set-model-profile, config-new-project, and config-ensure-section.
 *
 * @example
 * ```typescript
 * import { configSet, configNewProject } from './config-mutation.js';
 *
 * await configSet(['model_profile', 'quality'], '/project');
 * // { data: { updated: true, key: 'model_profile', value: 'quality' } }
 *
 * await configNewProject([], '/project');
 * // { data: { created: true, path: '/project/.planning/config.json' } }
 * ```
 */

import { readFile, lstat, open, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { CONFIG_DEFAULTS } from '../config.js';
import { GSDError, ErrorClassification } from '../errors.js';
import { assertResolvedPlanningContained, assertResolvedWorkstreamContained } from '../workstream-utils.js';
import { VALID_PROFILES, getAgentToModelMapForProfile } from './config-query.js';
import {
  VALID_CONFIG_KEYS,
  RUNTIME_STATE_KEYS,
  DYNAMIC_KEY_PATTERNS,
  getConfigValueDomainError,
  isValidConfigKeyPath,
} from './config-schema.js';
import { maskIfSecret } from './secrets.js';
import type { QueryHandler } from './utils.js';


// ─── VALID_CONFIG_KEYS ────────────────────────────────────────────────────
// Imported from ./config-schema.js — single source of truth, kept in sync
// with get-shit-done/bin/lib/config-schema.cjs by a CI parity test (#2653).

// ─── CONFIG_KEY_SUGGESTIONS (D9 — match CJS config.cjs:57-67) ────────────

/**
 * Curated typo correction map for known config key mistakes.
 * Checked before the general LCP fallback for more precise suggestions.
 */
const CONFIG_KEY_SUGGESTIONS: Record<string, string> = {
  'workflow.nyquist_validation_enabled': 'workflow.nyquist_validation',
  'agents.nyquist_validation_enabled': 'workflow.nyquist_validation',
  'nyquist.validation_enabled': 'workflow.nyquist_validation',
  'hooks.research_questions': 'workflow.research_before_questions',
  'workflow.research_questions': 'workflow.research_before_questions',
  'workflow.codereview': 'workflow.code_review',
  'workflow.review_command': 'workflow.code_review_command',
  'workflow.review': 'workflow.code_review',
  'workflow.code_review_level': 'workflow.code_review_depth',
  'workflow.review_depth': 'workflow.code_review_depth',
  'review.model': 'review.models.<cli-name>',
  'sub_repos': 'planning.sub_repos',
  'plan_checker': 'workflow.plan_check',
};

// ─── isValidConfigKey ─────────────────────────────────────────────────────

/**
 * Check whether a config key path is valid.
 *
 * Supports exact matches from VALID_CONFIG_KEYS plus dynamic patterns
 * like `agent_skills.<agent-type>` and `features.<feature_name>`.
 * Uses curated CONFIG_KEY_SUGGESTIONS before LCP fallback for typo correction.
 *
 * @param keyPath - Dot-notation config key path
 * @returns Object with valid flag and optional suggestion for typos
 */
export function isValidConfigKey(keyPath: string): { valid: boolean; suggestion?: string } {
  if (isValidConfigKeyPath(keyPath)) return { valid: true };

  // D9: Check curated suggestions before LCP fallback
  if (CONFIG_KEY_SUGGESTIONS[keyPath]) {
    return { valid: false, suggestion: CONFIG_KEY_SUGGESTIONS[keyPath] };
  }

  // Find closest suggestion using longest common prefix
  const keys = [...VALID_CONFIG_KEYS];
  let bestMatch = '';
  let bestScore = 0;

  for (const candidate of keys) {
    let shared = 0;
    const maxLen = Math.min(keyPath.length, candidate.length);
    for (let i = 0; i < maxLen; i++) {
      if (keyPath[i] === candidate[i]) shared++;
      else break;
    }
    if (shared > bestScore) {
      bestScore = shared;
      bestMatch = candidate;
    }
  }

  return { valid: false, suggestion: bestScore > 2 ? bestMatch : undefined };
}

// ─── parseConfigValue ─────────────────────────────────────────────────────

/**
 * Coerce a CLI string value to its native type.
 *
 * Ported from config.cjs lines 344-351.
 *
 * @param value - String value from CLI
 * @returns Coerced value: boolean, number, parsed JSON, or original string
 */
export function parseConfigValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !isNaN(Number(value))) return Number(value);
  if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
    try { return JSON.parse(value); } catch { /* keep as string */ }
  }
  return value;
}

// ─── setConfigValue ───────────────────────────────────────────────────────

/**
 * Set a value at a dot-notation path in a config object.
 *
 * Creates nested objects as needed along the path.
 *
 * @param obj - Config object to mutate
 * @param dotPath - Dot-notation key path (e.g., 'workflow.auto_advance')
 * @param value - Value to set
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getConfigValue(config: Record<string, unknown>, dotPath: string): unknown {
  let current: unknown = config;
  for (const key of dotPath.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setConfigValue(config: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.');
  let current = config;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function mergeConfigLayers(...layers: Record<string, unknown>[]): Record<string, unknown> {
  const merge = (
    base: Record<string, unknown>,
    override: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = isPlainObject(value) && isPlainObject(result[key])
        ? merge(result[key] as Record<string, unknown>, value)
        : structuredClone(value);
    }
    return result;
  };

  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    merged = merge(merged, layer);
  }
  return merged;
}

function assertValidConfigValue(keyPath: string, value: unknown): void {
  const expected = getConfigValueDomainError(keyPath, value);
  if (expected) {
    throw new GSDError(`Invalid ${keyPath} '${String(value)}'. ${expected}`, ErrorClassification.Validation);
  }
}

const ATOMIC_WRITE_CHILD = String.raw`
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

try {
  const expectedDev = BigInt(process.argv[1]);
  const expectedIno = BigInt(process.argv[2]);
  const targetName = process.argv[3];
  const expectedPath = process.argv[4];
  const parent = fs.statSync('.', { bigint: true });
  if (parent.dev !== expectedDev || parent.ino !== expectedIno || fs.realpathSync('.') !== expectedPath) {
    throw new Error('Refusing to write through replaced parent directory');
  }

  const tmpName = targetName + '.tmp.' + process.ppid + '.' + crypto.randomBytes(16).toString('hex');
  let identity;
  try {
    const fd = fs.openSync(tmpName, 'wx');
    try {
      identity = fs.fstatSync(fd, { bigint: true });
      fs.writeFileSync(fd, fs.readFileSync(0));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const current = fs.lstatSync(tmpName, { bigint: true });
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('Refusing to rename replaced temporary file');
    }
    fs.renameSync(tmpName, targetName);
  } catch (err) {
    if (identity) {
      try {
        const current = fs.lstatSync(tmpName, { bigint: true });
        if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) {
          fs.unlinkSync(tmpName);
        }
      } catch { /* already gone or replaced */ }
    }
    throw err;
  }
} catch (err) {
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exitCode = 1;
}
`;

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface ConfigMutationTarget extends FileIdentity {
  configPath: string;
  planningDir: string;
}

interface PlanningLock extends FileIdentity {
  path: string;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

async function resolveConfigMutationTarget(
  projectDir: string,
  workstream?: string,
): Promise<ConfigMutationTarget> {
  const planningDir = workstream
    ? await assertResolvedWorkstreamContained(projectDir, workstream)
    : await assertResolvedPlanningContained(projectDir);
  if (!planningDir) {
    throw new GSDError('Unable to resolve project-contained planning directory', ErrorClassification.Validation);
  }
  try {
    const stat = await lstat(planningDir, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe planning directory');
    return {
      configPath: join(planningDir, 'config.json'),
      planningDir,
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GSDError(`Planning directory is unavailable for config mutation: ${detail}`, ErrorClassification.Validation);
  }
}

async function readConfigFile(configPath: string): Promise<{
  exists: boolean;
  config: Record<string, unknown>;
}> {
  try {
    const before = await lstat(configPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new GSDError('Refusing to read unsafe config.json', ErrorClassification.Validation);
    }
    const raw = await readFile(configPath, 'utf-8');
    const after = await lstat(configPath, { bigint: true });
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new GSDError('config.json changed identity while being read', ErrorClassification.Validation);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      throw new GSDError('config.json must contain a JSON object', ErrorClassification.Validation);
    }
    return { exists: true, config: parsed };
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
    if (code === 'ENOENT') return { exists: false, config: {} };
    if (err instanceof GSDError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new GSDError(`Failed to read config.json: ${detail}`, ErrorClassification.Validation);
  }
}

const PLANNING_LOCK_TIMEOUT_MS = 10_000;
const PLANNING_LOCK_STALE_MS = 30_000;
const PLANNING_LOCK_RETRY_MS = 100;

async function releasePlanningLock(lock: PlanningLock): Promise<void> {
  try {
    const current = await lstat(lock.path, { bigint: true });
    if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, lock)) {
      await unlink(lock.path);
    }
  } catch { /* already released or parent replaced */ }
}

async function acquirePlanningLock(
  target: ConfigMutationTarget,
  projectDir: string,
): Promise<PlanningLock> {
  const lockPath = join(target.planningDir, '.lock');
  const started = Date.now();

  while (Date.now() - started < PLANNING_LOCK_TIMEOUT_MS) {
    let handle;
    let createdLock: PlanningLock | undefined;
    try {
      handle = await open(lockPath, 'wx');
      const identity = await handle.stat({ bigint: true });
      createdLock = { path: lockPath, dev: identity.dev, ino: identity.ino };
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        cwd: projectDir,
        acquired: new Date().toISOString(),
      }));
      await handle.close();
      handle = undefined;

      const currentParent = await lstat(target.planningDir, { bigint: true });
      if (!currentParent.isDirectory() || currentParent.isSymbolicLink() ||
        !sameIdentity(currentParent, target)) {
        await releasePlanningLock(createdLock);
        throw new GSDError('Planning directory changed while acquiring config lock', ErrorClassification.Validation);
      }
      return createdLock;
    } catch (err: unknown) {
      if (handle) await handle.close().catch(() => undefined);
      if (createdLock && errorCode(err) !== 'EEXIST') await releasePlanningLock(createdLock);
      if (errorCode(err) !== 'EEXIST') throw err;

      try {
        const existing = await lstat(lockPath, { bigint: true });
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new GSDError('Refusing unsafe planning lock', ErrorClassification.Validation);
        }
        if (Date.now() - Number(existing.mtimeMs) > PLANNING_LOCK_STALE_MS) {
          const current = await lstat(lockPath, { bigint: true });
          if (current.isFile() && !current.isSymbolicLink() && sameIdentity(existing, current)) {
            await unlink(lockPath);
            continue;
          }
        }
      } catch (lockErr: unknown) {
        if (errorCode(lockErr) !== 'ENOENT') throw lockErr;
        continue;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, PLANNING_LOCK_RETRY_MS));
    }
  }

  throw new GSDError('Timed out waiting for active planning lock', ErrorClassification.Validation);
}

async function atomicWriteConfig(
  target: ConfigMutationTarget,
  config: Record<string, unknown>,
): Promise<void> {
  const parent = await lstat(target.planningDir, { bigint: true });
  if (parent.isSymbolicLink() || !parent.isDirectory() || !sameIdentity(parent, target)) {
    throw new GSDError('Refusing to write through unsafe planning directory', ErrorClassification.Validation);
  }
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      ATOMIC_WRITE_CHILD,
      target.dev.toString(),
      target.ino.toString(),
      basename(target.configPath),
      target.planningDir,
    ],
    {
      cwd: target.planningDir,
      input: Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf-8'),
      stdio: ['pipe', 'ignore', 'pipe'],
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.toString('utf-8').trim() || 'atomic write child failed';
    throw new GSDError(`Failed to write config.json: ${detail}`, ErrorClassification.Validation);
  }
}

async function withConfigLock<T>(
  projectDir: string,
  workstream: string | undefined,
  operation: (target: ConfigMutationTarget) => Promise<T>,
): Promise<T> {
  const target = await resolveConfigMutationTarget(projectDir, workstream);
  const lock = await acquirePlanningLock(target, projectDir);
  try {
    const revalidated = await resolveConfigMutationTarget(projectDir, workstream);
    if (revalidated.configPath !== target.configPath || !sameIdentity(revalidated, target)) {
      throw new GSDError('Planning directory changed during config mutation', ErrorClassification.Validation);
    }
    return await operation(target);
  } finally {
    await releasePlanningLock(lock);
  }
}

const VALID_CONFIG_SECTIONS: ReadonlySet<string> = new Set([
  ...[...VALID_CONFIG_KEYS, ...RUNTIME_STATE_KEYS]
    .filter((key) => key.includes('.'))
    .map((key) => key.split('.')[0]),
  ...DYNAMIC_KEY_PATTERNS.map((pattern) => pattern.description.split('.')[0]),
  'git',
  'workflow',
  'hooks',
  'agent_skills',
  'features',
  'review',
  'models',
  'dynamic_routing',
  'model_overrides',
  'model_profile_overrides',
  'claude_md_assembly',
]);

function assertValidConfigSection(sectionName: string): void {
  if (sectionName.includes('.') || !VALID_CONFIG_SECTIONS.has(sectionName)) {
    throw new GSDError(`Unknown config section: "${sectionName}"`, ErrorClassification.Validation);
  }
}

function isValidConfigObjectPrefix(path: string): boolean {
  if ([...VALID_CONFIG_KEYS, ...RUNTIME_STATE_KEYS].some((key) => key.startsWith(`${path}.`))) {
    return true;
  }
  if (path === 'review.models') return true;
  if (path === 'claude_md_assembly.blocks') return true;
  if (path === 'dynamic_routing.tier_models') return true;
  return /^model_profile_overrides\.[a-zA-Z0-9_-]+$/.test(path) &&
    isValidConfigKey(`${path}.opus`).valid;
}

function assertValidConfigPolicy(config: Record<string, unknown>, source: string): void {
  const visit = (value: unknown, path: string): void => {
    assertValidConfigValue(path, value);

    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (!path.includes('.')) {
        assertValidConfigSection(path);
      } else if ((entries.length === 0 && !isValidConfigKey(path).valid) ||
        (entries.length > 0 && !isValidConfigObjectPrefix(path))) {
        const validation = isValidConfigKey(path);
        const suggestion = validation.suggestion ? `. Did you mean: ${validation.suggestion}?` : '';
        throw new GSDError(
          `Unknown config key in ${source}: "${path}"${suggestion}`,
          ErrorClassification.Validation,
        );
      }

      for (const [childKey, childValue] of entries) {
        visit(childValue, `${path}.${childKey}`);
      }
      return;
    }

    if (!path.includes('.') && VALID_CONFIG_SECTIONS.has(path)) {
      throw new GSDError(
        `Invalid config section "${path}" in ${source}: expected object`,
        ErrorClassification.Validation,
      );
    }

    const validation = isValidConfigKey(path);
    if (!validation.valid) {
      const suggestion = validation.suggestion ? `. Did you mean: ${validation.suggestion}?` : '';
      throw new GSDError(
        `Unknown config key in ${source}: "${path}"${suggestion}`,
        ErrorClassification.Validation,
      );
    }
  };

  for (const [key, value] of Object.entries(config)) {
    visit(value, key);
  }
}

// ─── configSet ────────────────────────────────────────────────────────────

/**
 * Validate and write a key-value pair to config.json.
 *
 * Validates key against VALID_CONFIG_KEYS and coerces the CLI string value.
 *
 * @param args - args[0]=key, args[1]=value
 * @param projectDir - Project root directory
 * @throws GSDError with Validation if input or the mutation path is unsafe
 */
export const configSet: QueryHandler = async (args, projectDir, workstream) => {
  const keyPath = args[0];
  const rawValue = args[1];
  if (!keyPath) {
    throw new GSDError('Usage: config-set <key.path> <value>', ErrorClassification.Validation);
  }
  if (rawValue === undefined) {
    throw new GSDError('Usage: config-set <key.path> <value>', ErrorClassification.Validation);
  }

  const validation = isValidConfigKey(keyPath);
  if (!validation.valid) {
    const suggestion = validation.suggestion ? `. Did you mean: ${validation.suggestion}?` : '';
    throw new GSDError(
      `Unknown config key: "${keyPath}"${suggestion}`,
      ErrorClassification.Validation,
    );
  }

  const parsedValue = parseConfigValue(rawValue);
  assertValidConfigValue(keyPath, parsedValue);

  // D8: Context value validation (match CJS config.cjs:357-359)
  const VALID_CONTEXT_VALUES = ['dev', 'research', 'review'];
  if (keyPath === 'context' && !VALID_CONTEXT_VALUES.includes(String(parsedValue))) {
    throw new GSDError(
      `Invalid context value '${rawValue}'. Valid values: ${VALID_CONTEXT_VALUES.join(', ')}`,
      ErrorClassification.Validation,
    );
  }

  return withConfigLock(projectDir, workstream, async (target) => {
    const { config } = await readConfigFile(target.configPath);
    const previousValue = getConfigValue(config, keyPath);
    setConfigValue(config, keyPath, parsedValue);
    await atomicWriteConfig(target, config);

    const data: Record<string, unknown> = {
      updated: true,
      key: keyPath,
      value: maskIfSecret(keyPath, parsedValue),
    };
    if (previousValue !== undefined) {
      data.previousValue = maskIfSecret(keyPath, previousValue);
    }
    return { data };
  });
};

// ─── configSetModelProfile ────────────────────────────────────────────────

/**
 * Validate and write a model profile to config.json.
 *
 * @param args - args[0]=profileName
 * @param projectDir - Project root directory
 * @throws GSDError with Validation if profile or the mutation path is invalid
 */
export const configSetModelProfile: QueryHandler = async (args, projectDir, workstream) => {
  const profileName = args[0];
  if (!profileName) {
    throw new GSDError(
      `Usage: config-set-model-profile <${VALID_PROFILES.join('|')}>`,
      ErrorClassification.Validation,
    );
  }

  const normalized = profileName.toLowerCase().trim();
  if (!VALID_PROFILES.includes(normalized)) {
    throw new GSDError(
      `Invalid profile '${profileName}'. Valid profiles: ${VALID_PROFILES.join(', ')}`,
      ErrorClassification.Validation,
    );
  }

  return withConfigLock(projectDir, workstream, async (target) => {
    const { config } = await readConfigFile(target.configPath);
    const previous = typeof config.model_profile === 'string'
      ? config.model_profile.toLowerCase().trim()
      : '';
    const previousProfile = VALID_PROFILES.includes(previous) ? previous : 'balanced';
    config.model_profile = normalized;
    await atomicWriteConfig(target, config);
    return {
      data: {
        updated: true,
        profile: normalized,
        previousProfile,
        agentToModelMap: getAgentToModelMapForProfile(normalized),
      },
    };
  });
};

// ─── configNewProject ─────────────────────────────────────────────────────

/**
 * Create config.json from validated defaults and optional user choices.
 *
 * @param args - args[0]=optional JSON string of user choices
 * @param projectDir - Project root directory
 * @returns QueryResult with created status and the contained config path
 */
export const configNewProject: QueryHandler = async (args, projectDir, workstream) => {

  const initialTarget = await resolveConfigMutationTarget(projectDir, workstream);
  if ((await readConfigFile(initialTarget.configPath)).exists) {
    return { data: { created: false, reason: 'already_exists' } };
  }

  // Parse user choices
  let userChoices: Record<string, unknown> = {};
  if (args[0] && args[0].trim() !== '') {
    try {
      userChoices = JSON.parse(args[0]) as Record<string, unknown>;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GSDError(`Invalid JSON for config-new-project: ${msg}`, ErrorClassification.Validation);
    }
    if (!isPlainObject(userChoices)) {
      throw new GSDError('Invalid JSON for config-new-project: expected object', ErrorClassification.Validation);
    }
    assertValidConfigPolicy(userChoices, 'config-new-project user choices');
  }

  // D11: Load global defaults from ~/.gsd/defaults.json if present
  const homeDir = homedir();
  const defaultsPath = join(homeDir, '.gsd', 'defaults.json');
  let globalDefaults: Record<string, unknown> = {};
  try {
    const defaultsRaw = await readFile(defaultsPath, 'utf-8');
    const parsedGlobalDefaults = JSON.parse(defaultsRaw) as unknown;
    if (!isPlainObject(parsedGlobalDefaults)) {
      throw new GSDError('Invalid global defaults: expected object', ErrorClassification.Validation);
    }
    assertValidConfigPolicy(parsedGlobalDefaults, 'global defaults');
    globalDefaults = parsedGlobalDefaults;
  } catch (err: unknown) {
    if (err instanceof GSDError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new GSDError(`Invalid global defaults JSON: ${err.message}`, ErrorClassification.Validation);
    }
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
    if (code !== 'ENOENT') {
      throw err;
    }
    // No global defaults — continue with hardcoded defaults only
  }

  const defaults = structuredClone(CONFIG_DEFAULTS) as unknown as Record<string, unknown>;
  defaults.brave_search = !!(process.env.BRAVE_API_KEY || await readFile(join(homeDir, '.gsd', 'brave_api_key')).then(() => true, () => false));
  defaults.firecrawl = !!(process.env.FIRECRAWL_API_KEY || await readFile(join(homeDir, '.gsd', 'firecrawl_api_key')).then(() => true, () => false));
  defaults.exa_search = !!(process.env.EXA_API_KEY || await readFile(join(homeDir, '.gsd', 'exa_api_key')).then(() => true, () => false));
  const config = mergeConfigLayers(defaults, globalDefaults, userChoices);
  assertValidConfigPolicy(config, 'new project config');

  return withConfigLock(projectDir, workstream, async (target) => {
    if ((await readConfigFile(target.configPath)).exists) {
      return { data: { created: false, reason: 'already_exists' } };
    }
    await atomicWriteConfig(target, config);
    return { data: { created: true, path: target.configPath } };
  });
};

// ─── configEnsureSection ──────────────────────────────────────────────────

/**
 * Idempotently ensure a validated top-level section exists in config.json.
 *
 * @param args - args[0]=sectionName
 * @param projectDir - Project root directory
 * @throws GSDError with Validation if section or the mutation path is invalid
 */
export const configEnsureSection: QueryHandler = async (args, projectDir, workstream) => {
  const sectionName = args[0];
  if (!sectionName) {
    throw new GSDError('Usage: config-ensure-section <section>', ErrorClassification.Validation);
  }
  assertValidConfigSection(sectionName);

  return withConfigLock(projectDir, workstream, async (target) => {
    const { config } = await readConfigFile(target.configPath);
    if (!(sectionName in config)) {
      config[sectionName] = {};
      await atomicWriteConfig(target, config);
    }
    return { data: { ensured: true, section: sectionName } };
  });
};
