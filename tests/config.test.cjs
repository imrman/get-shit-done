/**
 * GSD Tools Tests - config.cjs
 *
 * CLI integration tests for config-ensure-section, config-set, and config-get
 * commands exercised through gsd-tools.cjs via execSync.
 *
 * Requirements: TEST-13
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempDir, createTempProject, cleanup } = require('./helpers.cjs');
const { atomicWriteFileSync, loadConfig } = require('../get-shit-done/bin/lib/core.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

const INVALID_SECURITY_VALUES = [
  ['security_enforcement', 0],
  ['security_asvs_level', 0],
  ['security_block_on', 'none'],
];

const CONFIG_MUTATION_COMMANDS = [
  ['config-set', ['config-set', 'model_profile', 'quality']],
  ['config-set-model-profile', ['config-set-model-profile', 'quality']],
  ['config-new-project', ['config-new-project', '{}']],
  ['config-ensure-section', ['config-ensure-section']],
];

const CJS_VALUE_DOMAIN_CASES = [
  ['model_profile', 'turbo'],
  ['workflow.drift_action', 'block'],
  ['workflow.drift_threshold', 0],
  ['workflow.drift_threshold', 1.5],
  ['workflow.post_planning_gaps', 'yes'],
];

function setupPlanningRootRedirect(tmpDir, outsideDir) {
  const planningPath = path.join(tmpDir, '.planning');
  const outsideConfigPath = path.join(outsideDir, 'config.json');
  const sentinel = '{"model_profile":"balanced","sentinel":true}\n';

  fs.rmSync(planningPath, { recursive: true, force: true });
  fs.writeFileSync(outsideConfigPath, sentinel, 'utf-8');
  fs.symlinkSync(outsideDir, planningPath, 'dir');

  return { outsideConfigPath, sentinel };
}

function assertRejectsWorkstreamRedirect(tmpDir, redirectDir, command) {
  const workstreamName = 'linked-workstream';
  const workstreamsDir = path.join(tmpDir, '.planning', 'workstreams');
  const redirectedConfigPath = path.join(redirectDir, 'config.json');
  const sentinel = '{"sentinel":true}\n';
  const env = {
    GSD_PROJECT: '',
    GSD_WORKSTREAM: workstreamName,
    HOME: tmpDir,
    USERPROFILE: tmpDir,
  };

  fs.mkdirSync(workstreamsDir, { recursive: true });
  fs.symlinkSync(redirectDir, path.join(workstreamsDir, workstreamName), 'dir');

  const createResult = runGsdTools(command, tmpDir, env);
  assert.strictEqual(createResult.success, false, createResult.error);
  assert.match(createResult.error, /Invalid workstream config path/);
  assert.strictEqual(fs.existsSync(redirectedConfigPath), false);

  fs.writeFileSync(redirectedConfigPath, sentinel, 'utf-8');
  const updateResult = runGsdTools(command, tmpDir, env);
  assert.strictEqual(updateResult.success, false, updateResult.error);
  assert.match(updateResult.error, /Invalid workstream config path/);
  assert.strictEqual(fs.readFileSync(redirectedConfigPath, 'utf-8'), sentinel);
}

function assertRejectsConfigLeafRedirect(tmpDir, configPath, env, sentinel) {
  const outsideDir = createTempDir('gsd-config-leaf-outside-');
  const victimPath = path.join(outsideDir, 'victim.json');
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  const savedProject = process.env.GSD_PROJECT;
  const savedWorkstream = process.env.GSD_WORKSTREAM;
  let readAttempts = 0;
  let writeAttempts = 0;
  let thrown;

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(victimPath, sentinel, 'utf-8');
    fs.symlinkSync(victimPath, configPath, 'file');
    const canonicalConfigPath = path.join(
      fs.realpathSync(path.dirname(configPath)),
      path.basename(configPath)
    );

    process.env.GSD_PROJECT = env.GSD_PROJECT || '';
    process.env.GSD_WORKSTREAM = env.GSD_WORKSTREAM || '';
    fs.readFileSync = (filePath, ...args) => {
      if (filePath === canonicalConfigPath) readAttempts += 1;
      return originalReadFileSync(filePath, ...args);
    };
    fs.writeFileSync = (filePath, ...args) => {
      if (filePath === canonicalConfigPath) writeAttempts += 1;
      return originalWriteFileSync(filePath, ...args);
    };

    try {
      loadConfig(tmpDir);
    } catch (err) {
      thrown = err;
    }
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    if (savedProject === undefined) delete process.env.GSD_PROJECT;
    else process.env.GSD_PROJECT = savedProject;
    if (savedWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = savedWorkstream;
  }

  try {
    assert.deepStrictEqual(
      {
        rejected: thrown instanceof Error,
        rejectedUnsafePath: /outside (the )?project|symlink/i.test(thrown?.message || ''),
        readAttempts,
        writeAttempts,
        victim: fs.readFileSync(victimPath, 'utf-8'),
      },
      {
        rejected: true,
        rejectedUnsafePath: true,
        readAttempts: 0,
        writeAttempts: 0,
        victim: sentinel,
      }
    );
  } finally {
    cleanup(outsideDir);
  }
}

describe('CJS config workstream mutation security', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('preserves project-scoped workstream mutation with GSD_PROJECT and GSD_WORKSTREAM', () => {
    const projectName = 'project-a';
    const workstreamName = 'stream-a';
    const projectConfigPath = path.join(tmpDir, '.planning', projectName, 'config.json');
    const workstreamConfigPath = path.join(
      tmpDir,
      '.planning',
      projectName,
      'workstreams',
      workstreamName,
      'config.json'
    );

    fs.mkdirSync(path.dirname(workstreamConfigPath), { recursive: true });
    fs.writeFileSync(projectConfigPath, '{"model_profile":"balanced"}\n', 'utf-8');
    fs.writeFileSync(workstreamConfigPath, '{"model_profile":"balanced"}\n', 'utf-8');

    const result = runGsdTools(
      ['config-set', 'model_profile', 'quality'],
      tmpDir,
      { GSD_PROJECT: projectName, GSD_WORKSTREAM: workstreamName }
    );

    assert.ok(result.success, result.error);
    assert.strictEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8')).model_profile, 'balanced');
    assert.strictEqual(JSON.parse(fs.readFileSync(workstreamConfigPath, 'utf-8')).model_profile, 'quality');
    assert.strictEqual(
      fs.existsSync(path.join(tmpDir, '.planning', 'workstreams', workstreamName, 'config.json')),
      false
    );
  });

  for (const [name, command] of CONFIG_MUTATION_COMMANDS) {
    test(`${name} rejects an outside workstream symlink before redirected config writes`, () => {
      const outsideDir = createTempDir('gsd-config-outside-');
      try {
        assertRejectsWorkstreamRedirect(tmpDir, outsideDir, command);
      } finally {
        cleanup(outsideDir);
      }
    });
  }

  test('rejects an in-project workstream redirect outside the canonical workstream tree', () => {
    const redirectDir = path.join(tmpDir, '.planning', 'redirected-workstream');
    fs.mkdirSync(redirectDir, { recursive: true });

    assertRejectsWorkstreamRedirect(
      tmpDir,
      redirectDir,
      ['config-set', 'model_profile', 'quality']
    );
  });
});

describe('CJS config root planning symlink security', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('loadConfig rejects a root .planning symlink outside the project without mutation', () => {
    const outsideDir = createTempDir('gsd-config-outside-');
    try {
      const { outsideConfigPath, sentinel } = setupPlanningRootRedirect(tmpDir, outsideDir);

      assert.throws(() => loadConfig(tmpDir), /outside the project/);
      assert.strictEqual(fs.readFileSync(outsideConfigPath, 'utf-8'), sentinel);
    } finally {
      cleanup(outsideDir);
    }
  });

  for (const [name, command] of CONFIG_MUTATION_COMMANDS) {
    test(`${name} rejects a root .planning symlink outside the project`, () => {
      const outsideDir = createTempDir('gsd-config-outside-');
      try {
        const { outsideConfigPath, sentinel } = setupPlanningRootRedirect(tmpDir, outsideDir);
        const result = runGsdTools(command, tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });

        assert.strictEqual(fs.readFileSync(outsideConfigPath, 'utf-8'), sentinel);
        assert.strictEqual(result.success, false, result.error);
      } finally {
        cleanup(outsideDir);
      }
    });
  }

  test('config-get rejects a root .planning symlink outside the project', () => {
    const outsideDir = createTempDir('gsd-config-outside-');
    try {
      const { outsideConfigPath, sentinel } = setupPlanningRootRedirect(tmpDir, outsideDir);
      const result = runGsdTools(['config-get', 'model_profile'], tmpDir);

      assert.strictEqual(fs.readFileSync(outsideConfigPath, 'utf-8'), sentinel);
      assert.strictEqual(result.success, false, result.error);
    } finally {
      cleanup(outsideDir);
    }
  });

  test('config-path rejects a root .planning symlink outside the project', () => {
    const outsideDir = createTempDir('gsd-config-outside-');
    try {
      const { outsideConfigPath, sentinel } = setupPlanningRootRedirect(tmpDir, outsideDir);
      const result = runGsdTools('config-path', tmpDir);

      assert.strictEqual(fs.readFileSync(outsideConfigPath, 'utf-8'), sentinel);
      assert.strictEqual(result.success, false, result.error);
    } finally {
      cleanup(outsideDir);
    }
  });
});

describe('loadConfig config.json symlink leaf security', { concurrency: false }, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const { scope, relativePath, env, sentinel } of [
    {
      scope: 'root',
      relativePath: ['.planning', 'config.json'],
      env: {},
      sentinel: '{"depth":"quick"}\n',
    },
    {
      scope: 'project',
      relativePath: ['.planning', 'project-a', 'config.json'],
      env: { GSD_PROJECT: 'project-a' },
      sentinel: '{"model_profile":"quality"}\n',
    },
    {
      scope: 'workstream',
      relativePath: ['.planning', 'project-a', 'workstreams', 'stream-a', 'config.json'],
      env: { GSD_PROJECT: 'project-a', GSD_WORKSTREAM: 'stream-a' },
      sentinel: '{"model_profile":"quality"}\n',
    },
  ]) {
    test(`rejects an external ${scope} config.json symlink leaf before read or write`, () => {
      assertRejectsConfigLeafRedirect(
        tmpDir,
        path.join(tmpDir, ...relativePath),
        env,
        sentinel
      );
    });
  }
});

describe('atomicWriteFileSync symlink safety', { concurrency: false }, () => {
  test('rejects a pre-planted predictable temporary-file symlink', () => {
    const tmpDir = createTempDir('gsd-atomic-write-');
    try {
      const targetPath = path.join(tmpDir, 'target.json');
      const victimPath = path.join(tmpDir, 'victim.txt');
      const attackerTmpPath = `${targetPath}.tmp.${process.pid}`;
      const sentinel = 'do not overwrite\n';
      fs.writeFileSync(victimPath, sentinel, 'utf-8');
      fs.symlinkSync(victimPath, attackerTmpPath, 'file');

      let thrown;
      try {
        atomicWriteFileSync(targetPath, 'attacker content\n');
      } catch (err) {
        thrown = err;
      }

      const attackerSymlinkRemains = (() => {
        try { return fs.lstatSync(attackerTmpPath).isSymbolicLink(); } catch { return false; }
      })();
      assert.deepStrictEqual(
        {
          threw: thrown instanceof Error,
          victim: fs.readFileSync(victimPath, 'utf-8'),
          targetExists: fs.existsSync(targetPath),
          attackerSymlinkRemains,
        },
        {
          threw: true,
          victim: sentinel,
          targetExists: false,
          attackerSymlinkRemains: true,
        }
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('renames from a non-predictable temporary source', () => {
    const tmpDir = createTempDir('gsd-atomic-write-');
    const targetPath = path.join(tmpDir, 'target.json');
    const predictableTmpPath = `${targetPath}.tmp.${process.pid}`;
    const renameSourcePath = path.join(tmpDir, 'rename-source.txt');
    const originalSpawnSync = childProcess.spawnSync;

    try {
      childProcess.spawnSync = (command, args, options) => {
        const childArgs = [...args];
        childArgs[1] = [
          "const testFs = require('fs');",
          'const testRenameSync = testFs.renameSync;',
          'testFs.renameSync = (sourcePath, destinationPath) => {',
          `  testFs.writeFileSync(${JSON.stringify(renameSourcePath)}, sourcePath, 'utf8');`,
          '  return testRenameSync(sourcePath, destinationPath);',
          '};',
          childArgs[1],
        ].join('\n');
        return originalSpawnSync(command, childArgs, options);
      };

      atomicWriteFileSync(targetPath, 'safe content\n');

      const renameSource = fs.readFileSync(renameSourcePath, 'utf8');
      assert.notStrictEqual(renameSource, path.basename(predictableTmpPath));
      assert.match(renameSource, /^target\.json\.tmp\.\d+\.[0-9a-f]{32}$/);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf-8'), 'safe content\n');
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      cleanup(tmpDir);
    }
  });

  test('does not redirect a config write when its parent is swapped for an external symlink', { concurrency: false }, () => {
    const tmpDir = createTempDir('gsd-atomic-write-');
    const outsideDir = createTempDir('gsd-atomic-outside-');
    const configParentPath = path.join(tmpDir, '.planning', 'project-a');
    const movedParentPath = `${configParentPath}.before-swap`;
    const configPath = path.join(configParentPath, 'config.json');
    const outsideConfigPath = path.join(outsideDir, 'config.json');
    const originalConfig = '{"model_profile":"balanced"}\n';
    const sentinel = '{"sentinel":"external"}\n';
    const replacement = '{"model_profile":"quality"}\n';
    const originalCwd = process.cwd();
    const originalSpawnSync = childProcess.spawnSync;
    let swapped = false;
    let thrown;

    try {
      fs.mkdirSync(configParentPath, { recursive: true });
      fs.writeFileSync(configPath, originalConfig, 'utf-8');
      fs.writeFileSync(outsideConfigPath, sentinel, 'utf-8');
      childProcess.spawnSync = (command, args, options) => {
        if (!swapped) {
          fs.renameSync(configParentPath, movedParentPath);
          fs.symlinkSync(outsideDir, configParentPath, 'dir');
          swapped = true;
        }
        return originalSpawnSync(command, args, options);
      };

      try {
        atomicWriteFileSync(configPath, replacement);
      } catch (err) {
        thrown = err;
      }
    } finally {
      childProcess.spawnSync = originalSpawnSync;
    }

    try {
      assert.strictEqual(swapped, true, 'test setup must swap the config parent at the spawn boundary');
      assert.strictEqual(thrown instanceof Error, true, 'atomic write must reject the replaced parent');
      assert.strictEqual(process.cwd(), originalCwd, 'atomic write must not change the parent process cwd');
      assert.strictEqual(fs.readFileSync(outsideConfigPath, 'utf-8'), sentinel);
      assert.deepStrictEqual(fs.readdirSync(outsideDir).sort(), ['config.json']);
      assert.strictEqual(fs.readFileSync(path.join(movedParentPath, 'config.json'), 'utf-8'), originalConfig);
    } finally {
      cleanup(tmpDir);
      cleanup(outsideDir);
    }
  });

  test('rejects a rename-boundary temporary source swap', () => {
    const tmpDir = createTempDir('gsd-atomic-write-');
    const outsideDir = createTempDir('gsd-atomic-victim-');
    const targetPath = path.join(tmpDir, 'target.json');
    const victimPath = path.join(outsideDir, 'victim.txt');
    const swapMarkerPath = path.join(outsideDir, 'swap-marker');
    const safeOriginal = 'safe original\n';
    const victimSentinel = 'external victim unchanged\n';
    const originalSpawnSync = childProcess.spawnSync;
    let thrown;

    try {
      fs.writeFileSync(targetPath, safeOriginal, 'utf-8');
      fs.writeFileSync(victimPath, victimSentinel, 'utf-8');
      childProcess.spawnSync = (command, args, options) => {
        const childArgs = [...args];
        childArgs[1] = [
          "const testFs = require('fs');",
          'const testCloseSync = testFs.closeSync;',
          'let testSwapped = false;',
          'testFs.closeSync = (fd) => {',
          '  testCloseSync(fd);',
          '  if (testSwapped) return;',
          `  const tempName = testFs.readdirSync('.').find((entry) => entry.startsWith(${JSON.stringify(`${path.basename(targetPath)}.tmp.`)}));`,
          '  if (!tempName) return;',
          '  testFs.unlinkSync(tempName);',
          `  testFs.symlinkSync(${JSON.stringify(victimPath)}, tempName, 'file');`,
          '  testSwapped = true;',
          `  testFs.writeFileSync(${JSON.stringify(swapMarkerPath)}, 'swapped');`,
          '};',
          childArgs[1],
        ].join('\n');
        return originalSpawnSync(command, childArgs, options);
      };

      try {
        atomicWriteFileSync(targetPath, 'trusted replacement\n');
      } catch (err) {
        thrown = err;
      }
    } finally {
      childProcess.spawnSync = originalSpawnSync;
    }

    try {
      assert.deepStrictEqual(
        {
          swapped: fs.existsSync(swapMarkerPath),
          rejected: thrown instanceof Error,
          targetIsSymlink: fs.lstatSync(targetPath).isSymbolicLink(),
          target: fs.readFileSync(targetPath, 'utf-8'),
          victim: fs.readFileSync(victimPath, 'utf-8'),
        },
        {
          swapped: true,
          rejected: true,
          targetIsSymlink: false,
          target: safeOriginal,
          victim: victimSentinel,
        }
      );
    } finally {
      cleanup(tmpDir);
      cleanup(outsideDir);
    }
  });
});

describe('CJS config project and workstream path regressions', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-path and config-set stay scoped to GSD_PROJECT without a workstream', () => {
    const projectName = 'project-a';
    const rootConfigPath = path.join(tmpDir, '.planning', 'config.json');
    const projectConfigPath = path.join(tmpDir, '.planning', projectName, 'config.json');
    const rootSentinel = '{"model_profile":"balanced","root":true}\n';
    const projectSentinel = '{"model_profile":"balanced","project":true}\n';
    const env = { GSD_PROJECT: projectName, GSD_WORKSTREAM: '', HOME: tmpDir, USERPROFILE: tmpDir };

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(rootConfigPath, rootSentinel, 'utf-8');
    fs.writeFileSync(projectConfigPath, projectSentinel, 'utf-8');

    const pathResult = runGsdTools('config-path', tmpDir, env);
    assert.ok(pathResult.success, pathResult.error);
    assert.strictEqual(
      pathResult.output.trim(),
      path.join(fs.realpathSync(path.dirname(projectConfigPath)), 'config.json')
    );

    const setResult = runGsdTools(['config-set', 'model_profile', 'quality'], tmpDir, env);
    assert.ok(setResult.success, setResult.error);
    assert.strictEqual(fs.readFileSync(rootConfigPath, 'utf-8'), rootSentinel);
    assert.strictEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8')).model_profile, 'quality');
  });

  test('loadConfig rejects an external workstream symlink before migration writes', () => {
    const outsideDir = createTempDir('gsd-config-outside-');
    const projectName = 'project-a';
    const workstreamName = 'linked-workstream';
    const workstreamPath = path.join(tmpDir, '.planning', projectName, 'workstreams', workstreamName);
    const outsideConfigPath = path.join(outsideDir, 'config.json');
    const outsideSentinel = '{"depth":"quick","sentinel":"outside"}\n';
    const savedProject = process.env.GSD_PROJECT;
    const savedWorkstream = process.env.GSD_WORKSTREAM;

    try {
      fs.mkdirSync(path.dirname(workstreamPath), { recursive: true });
      fs.writeFileSync(outsideConfigPath, outsideSentinel, 'utf-8');
      fs.symlinkSync(outsideDir, workstreamPath, 'dir');
      process.env.GSD_PROJECT = projectName;
      process.env.GSD_WORKSTREAM = workstreamName;

      let thrown;
      try {
        loadConfig(tmpDir);
      } catch (err) {
        thrown = err;
      }

      assert.ok(thrown instanceof Error, 'loadConfig must reject an external workstream path');
      assert.match(thrown.message, /outside (the )?project/);
      assert.strictEqual(fs.readFileSync(outsideConfigPath, 'utf-8'), outsideSentinel);
    } finally {
      if (savedProject === undefined) delete process.env.GSD_PROJECT;
      else process.env.GSD_PROJECT = savedProject;
      if (savedWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = savedWorkstream;
      cleanup(outsideDir);
    }
  });
});

// ─── config-ensure-section ───────────────────────────────────────────────────

describe('config-ensure-section command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates config.json with expected structure and types', () => {
    const result = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    const config = readConfig(tmpDir);
    // Verify structure and types — exact values may vary if ~/.gsd/defaults.json exists
    assert.strictEqual(typeof config.model_profile, 'string');
    assert.strictEqual(typeof config.commit_docs, 'boolean');
    assert.strictEqual(typeof config.parallelization, 'boolean');
    assert.ok(config.git && typeof config.git === 'object', 'git should be an object');
    assert.strictEqual(typeof config.git.branching_strategy, 'string');
    assert.ok(config.workflow && typeof config.workflow === 'object', 'workflow should be an object');
    assert.strictEqual(typeof config.workflow.research, 'boolean');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean');
    assert.strictEqual(typeof config.workflow.nyquist_validation, 'boolean');
    // These hardcoded defaults are always present (may be overridden by user defaults)
    assert.ok('model_profile' in config, 'model_profile should exist');
    assert.ok('brave_search' in config, 'brave_search should exist');
    assert.ok('search_gitignored' in config, 'search_gitignored should exist');
  });

  test('is idempotent — returns already_exists on second call', () => {
    const first = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(first.success, `First call failed: ${first.error}`);
    const firstOutput = JSON.parse(first.output);
    assert.strictEqual(firstOutput.created, true);

    const second = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(second.success, `Second call failed: ${second.error}`);
    const secondOutput = JSON.parse(second.output);
    assert.strictEqual(secondOutput.created, false);
    assert.strictEqual(secondOutput.reason, 'already_exists');
  });

  test('detects Brave Search from file-based key', () => {
    // runGsdTools sandboxes HOME=tmpDir, so brave_api_key is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'brave_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.brave_search, true);
  });

  test('merges user defaults from defaults.json', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      model_profile: 'quality',
      commit_docs: false,
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality', 'model_profile should be overridden');
    assert.strictEqual(config.commit_docs, false, 'commit_docs should be overridden');
    assert.ok(config.git && typeof config.git === 'object', 'git should be an object');
    assert.strictEqual(typeof config.git.branching_strategy, 'string', 'git.branching_strategy should be a string');
  });

  test('merges nested workflow keys from defaults.json preserving unset keys', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      workflow: { research: false },
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false, 'research should be overridden');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean', 'plan_check should be a boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean', 'verifier should be a boolean');
  });
});

// ─── config-set ──────────────────────────────────────────────────────────────

describe('config-set command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create initial config
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sets a top-level string value', () => {
    const result = runGsdTools('config-set model_profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.key, 'model_profile');
    assert.strictEqual(output.value, 'quality');

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
  });

  test('coerces true to boolean', () => {
    const result = runGsdTools('config-set commit_docs true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(typeof config.commit_docs, 'boolean');
  });

  test('coerces false to boolean', () => {
    const result = runGsdTools('config-set commit_docs false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(typeof config.commit_docs, 'boolean');
  });

  test('coerces numeric strings to numbers', () => {
    const result = runGsdTools('config-set granularity 42', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.granularity, 42);
    assert.strictEqual(typeof config.granularity, 'number');
  });

  test('rejects constrained value domains without mutation', () => {
    for (const [key, invalidValue] of CJS_VALUE_DOMAIN_CASES) {
      const before = readConfig(tmpDir);
      const result = runGsdTools(['config-set', key, String(invalidValue)], tmpDir);

      assert.strictEqual(result.success, false, `${key}=${invalidValue} must be rejected`);
      assert.deepStrictEqual(readConfig(tmpDir), before, `${key}=${invalidValue} must not mutate config.json`);
    }
  });

  test('accepts representative constrained values', () => {
    for (const [key, value] of [
      ['model_profile', 'quality'],
      ['workflow.drift_action', 'warn'],
      ['workflow.drift_threshold', '1'],
      ['workflow.post_planning_gaps', 'false'],
    ]) {
      const result = runGsdTools(['config-set', key, value], tmpDir);
      assert.ok(result.success, `${key}=${value} failed: ${result.error}`);
    }
  });

  test('sets nested values via dot-notation', () => {
    const result = runGsdTools('config-set workflow.research false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false);
  });

  test('auto-creates nested objects for dot-notation', () => {
    // Start with empty config
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.research false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false);
    assert.strictEqual(typeof config.workflow, 'object');
  });

  test('rejects unknown config keys', () => {
    const result = runGsdTools('config-set workflow.nyquist_validation_enabled false', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
  });

  test('sets workflow.text_mode for remote session support', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.text_mode true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.text_mode, true);
  });

  test('sets workflow.use_worktrees to disable worktree isolation', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.use_worktrees, false);
  });

  test('sets git.base_branch for non-main default branches', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set git.base_branch master', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.base_branch, 'master');
  });

  test('sets intel.enabled to opt into the intel subsystem', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set intel.enabled true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.intel.enabled, true);
  });

  for (const [key, invalidValue] of INVALID_SECURITY_VALUES) {
    test(`CJS config security rejects workflow.${key}=${invalidValue} without mutation`, () => {
      const before = readConfig(tmpDir);
      const result = runGsdTools(['config-set', `workflow.${key}`, String(invalidValue)], tmpDir);

      assert.strictEqual(result.success, false, `workflow.${key}=${invalidValue} must be rejected`);
      assert.ok(result.error.includes(`Invalid workflow.${key}`), result.error);
      assert.deepStrictEqual(readConfig(tmpDir), before);
    });
  }

  test('CJS config security accepts representative valid values', () => {
    for (const [key, value] of [
      ['security_enforcement', 'false'],
      ['security_asvs_level', '2'],
      ['security_block_on', 'medium'],
    ]) {
      const result = runGsdTools(['config-set', `workflow.${key}`, value], tmpDir);
      assert.ok(result.success, `workflow.${key}=${value} failed: ${result.error}`);
    }

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.security_enforcement, false);
    assert.strictEqual(config.workflow.security_asvs_level, 2);
    assert.strictEqual(config.workflow.security_block_on, 'medium');
  });

  test('errors when no key path provided', () => {
    const result = runGsdTools('config-set', tmpDir);
    assert.strictEqual(result.success, false);
  });

  test('rejects missing value without mutating model_profile', () => {
    const before = readConfig(tmpDir);
    const result = runGsdTools('config-set model_profile', tmpDir);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Usage: config-set <key\.path> <value>/);

    const after = readConfig(tmpDir);
    assert.strictEqual(after.model_profile, before.model_profile);
    assert.ok('model_profile' in after);
    assert.deepStrictEqual(after, before);
  });

  test('rejects known invalid nyquist alias keys with a suggestion', () => {
    const result = runGsdTools('config-set workflow.nyquist_validation_enabled false', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key: workflow\.nyquist_validation_enabled/);
    assert.match(result.error, /workflow\.nyquist_validation/);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.nyquist_validation_enabled, undefined);
    assert.strictEqual(config.workflow.nyquist_validation, true);
  });

  test('rejects prototype-reserved segments in dynamic key paths', () => {
    const reservedPaths = [
      'model_profile_overrides.__proto__.opus',
      'model_profile_overrides.prototype.sonnet',
      'model_profile_overrides.constructor.haiku',
      'model_overrides.__proto__',
      'model_overrides.prototype',
      'model_overrides.constructor',
    ];

    for (const keyPath of reservedPaths) {
      writeConfig(tmpDir, {});
      const result = runGsdTools(['config-set', keyPath, 'owned'], tmpDir);
      assert.strictEqual(result.success, false, `${keyPath} must be rejected`);
      assert.match(result.error, /Unknown config key/);
      assert.deepStrictEqual(readConfig(tmpDir), {}, `${keyPath} must not mutate config.json`);
    }
  });
});

// ─── config-get ──────────────────────────────────────────────────────────────

describe('config-get command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create config with known values — sandbox HOME to avoid global defaults
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gets a top-level value', () => {
    const result = runGsdTools('config-get model_profile', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'balanced');
  });

  test('gets a nested value via dot-notation', () => {
    const result = runGsdTools('config-get workflow.research', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });

  test('errors for nonexistent key', () => {
    const result = runGsdTools('config-get nonexistent_key', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors for deeply nested nonexistent key', () => {
    const result = runGsdTools('config-get workflow.nonexistent', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('rejects prototype-reserved key path segments', () => {
    writeConfig(tmpDir, {});

    for (const keyPath of ['__proto__', 'constructor', 'constructor.prototype']) {
      const result = runGsdTools(['config-get', keyPath], tmpDir);
      assert.strictEqual(result.success, false, `${keyPath} must be rejected`);
      assert.match(result.error, /Key not found/);
    }
  });

  describe('when config.json does not exist', () => {
    let emptyTmpDir;

    beforeEach(() => {
      emptyTmpDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyTmpDir);
    });

    test('errors when config.json does not exist', () => {
      const result = runGsdTools('config-get model_profile', emptyTmpDir);
      assert.strictEqual(result.success, false);
      assert.ok(
        result.error.includes('No config.json'),
        `Expected "No config.json" in error: ${result.error}`
      );
    });
  });

  test('gets git.base_branch after it is set', () => {
    runGsdTools('config-set git.base_branch master', tmpDir);
    const result = runGsdTools('config-get git.base_branch', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'master');
  });

  test('errors for git.base_branch when not explicitly set', () => {
    // Default config from config-ensure-section does not include git.base_branch,
    // so config-get should return "Key not found" — this triggers auto-detect
    // fallback in the workflow (origin/HEAD detection).
    const result = runGsdTools('config-get git.base_branch', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors when no key path provided', () => {
    const result = runGsdTools('config-get', tmpDir);
    assert.strictEqual(result.success, false);
  });
});

// ─── config-new-project ───────────────────────────────────────────────────────

describe('config-new-project command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates full config with all expected keys', () => {
    const choices = JSON.stringify({
      mode: 'interactive',
      granularity: 'standard',
      parallelization: true,
      commit_docs: true,
      model_profile: 'balanced',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: true },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);

    // User choices present
    assert.strictEqual(config.mode, 'interactive');
    assert.strictEqual(config.granularity, 'standard');
    assert.strictEqual(config.parallelization, true);
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(config.model_profile, 'balanced');

    // Defaults materialized — these were silently missing before
    assert.strictEqual(typeof config.search_gitignored, 'boolean');
    assert.strictEqual(typeof config.brave_search, 'boolean');

    // git section present with all three keys
    assert.ok(config.git && typeof config.git === 'object', 'git section should exist');
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.strictEqual(config.git.phase_branch_template, 'gsd/phase-{phase}-{slug}');
    assert.strictEqual(config.git.milestone_branch_template, 'gsd/{milestone}-{slug}');

    // workflow section present with all keys
    assert.ok(config.workflow && typeof config.workflow === 'object', 'workflow section should exist');
    assert.strictEqual(config.workflow.research, true);
    assert.strictEqual(config.workflow.plan_check, true);
    assert.strictEqual(config.workflow.verifier, true);
    assert.strictEqual(config.workflow.nyquist_validation, true);
    assert.strictEqual(config.workflow.auto_advance, false);
    assert.strictEqual(config.workflow.node_repair, true);
    assert.strictEqual(config.workflow.node_repair_budget, 2);
    assert.strictEqual(config.workflow.ui_phase, true);
    assert.strictEqual(config.workflow.ui_safety_gate, true);

    // hooks section present
    assert.ok(config.hooks && typeof config.hooks === 'object', 'hooks section should exist');
    assert.strictEqual(config.hooks.context_warnings, true);
  });

  test('user choices override defaults', () => {
    const choices = JSON.stringify({
      mode: 'yolo',
      granularity: 'coarse',
      parallelization: false,
      commit_docs: false,
      model_profile: 'quality',
      workflow: { research: false, plan_check: false, verifier: true, nyquist_validation: false },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.mode, 'yolo');
    assert.strictEqual(config.granularity, 'coarse');
    assert.strictEqual(config.parallelization, false);
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(config.model_profile, 'quality');
    assert.strictEqual(config.workflow.research, false);
    assert.strictEqual(config.workflow.plan_check, false);
    assert.strictEqual(config.workflow.verifier, true);
    assert.strictEqual(config.workflow.nyquist_validation, false);
    // Defaults still present for non-chosen keys
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.strictEqual(typeof config.search_gitignored, 'boolean');
  });

  test('works with empty choices — all defaults materialized', () => {
    const result = runGsdTools(['config-new-project', '{}'], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(config.parallelization, true);
    assert.strictEqual(config.search_gitignored, false);
    assert.ok(config.git && typeof config.git === 'object');
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.ok(config.workflow && typeof config.workflow === 'object');
    assert.strictEqual(config.workflow.nyquist_validation, true);
    assert.strictEqual(config.workflow.auto_advance, false);
    assert.strictEqual(config.workflow.node_repair, true);
    assert.strictEqual(config.workflow.node_repair_budget, 2);
    assert.strictEqual(config.workflow.ui_phase, true);
    assert.strictEqual(config.workflow.ui_safety_gate, true);
    assert.ok(config.hooks && typeof config.hooks === 'object');
    assert.strictEqual(config.hooks.context_warnings, true);
  });

  test('is idempotent — returns already_exists if config exists', () => {
    const choices = JSON.stringify({ mode: 'yolo', granularity: 'fine' });

    const first = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(first.success, `First call failed: ${first.error}`);
    const firstOut = JSON.parse(first.output);
    assert.strictEqual(firstOut.created, true);

    const second = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(second.success, `Second call failed: ${second.error}`);
    const secondOut = JSON.parse(second.output);
    assert.strictEqual(secondOut.created, false);
    assert.strictEqual(secondOut.reason, 'already_exists');

    // Config unchanged
    const config = readConfig(tmpDir);
    assert.strictEqual(config.mode, 'yolo');
    assert.strictEqual(config.granularity, 'fine');
  });

  test('auto_advance in workflow choices is preserved', () => {
    const choices = JSON.stringify({
      mode: 'yolo',
      granularity: 'standard',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: true, auto_advance: true },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.auto_advance, true);
  });

  test('rejects invalid JSON choices', () => {
    const result = runGsdTools(['config-new-project', '{not-json}'], tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Invalid JSON'), `Expected "Invalid JSON" in: ${result.error}`);
  });

  test('output has created:true and path on success', () => {
    const choices = JSON.stringify({ mode: 'interactive', granularity: 'standard' });
    const result = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.created, true);
    assert.strictEqual(out.path, '.planning/config.json');
  });

  test('rejects constrained domains from choices and defaults before creation', () => {
    for (const [source, key, invalidValue] of ['choices', 'defaults'].flatMap((source) =>
      CJS_VALUE_DOMAIN_CASES.map(([key, value]) => [source, key, value])
    )) {
      const attemptDir = createTempProject('gsd-config-domain-');
      try {
        if (source === 'defaults') {
          const defaultsDir = path.join(attemptDir, '.gsd');
          fs.mkdirSync(defaultsDir, { recursive: true });
          fs.writeFileSync(
            path.join(defaultsDir, 'defaults.json'),
            JSON.stringify({ [key.split('.')[0]]: key.includes('.') ? { [key.split('.')[1]]: invalidValue } : invalidValue }),
            'utf-8'
          );
        }

        const choices = source === 'choices'
          ? JSON.stringify({ [key.split('.')[0]]: key.includes('.') ? { [key.split('.')[1]]: invalidValue } : invalidValue })
          : '{}';
        const result = runGsdTools(
          ['config-new-project', choices],
          attemptDir,
          { HOME: attemptDir, USERPROFILE: attemptDir }
        );

        assert.strictEqual(result.success, false, `${source} ${key}=${invalidValue} must be rejected`);
        assert.strictEqual(fs.existsSync(path.join(attemptDir, '.planning', 'config.json')), false);
      } finally {
        cleanup(attemptDir);
      }
    }
  });

  for (const [key, invalidValue] of INVALID_SECURITY_VALUES) {
    test(`CJS config security rejects bulk choice workflow.${key}=${invalidValue} before config creation`, () => {
      const choices = JSON.stringify({ workflow: { [key]: invalidValue } });
      const result = runGsdTools(
        ['config-new-project', choices],
        tmpDir,
        { HOME: tmpDir, USERPROFILE: tmpDir }
      );

      assert.strictEqual(result.success, false, `workflow.${key}=${invalidValue} must be rejected`);
      assert.ok(result.error.includes(`Invalid workflow.${key}`), result.error);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, '.planning', 'config.json')), false);
    });

    test(`CJS config security rejects default workflow.${key}=${invalidValue} before config creation`, () => {
      const gsdDir = path.join(tmpDir, '.gsd');
      fs.mkdirSync(gsdDir, { recursive: true });
      fs.writeFileSync(
        path.join(gsdDir, 'defaults.json'),
        JSON.stringify({ workflow: { [key]: invalidValue } }),
        'utf-8'
      );

      const result = runGsdTools(
        ['config-new-project', '{}'],
        tmpDir,
        { HOME: tmpDir, USERPROFILE: tmpDir }
      );

      assert.strictEqual(result.success, false, `workflow.${key}=${invalidValue} must be rejected`);
      assert.ok(result.error.includes(`Invalid workflow.${key}`), result.error);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, '.planning', 'config.json')), false);
    });
  }

  test('rejects prototype-reserved nested user choice keys', () => {
    const choices = '{"model_profile_overrides":{"__proto__":{"opus":"owned"}}}';
    const result = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key/);
    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.planning', 'config.json')), false);
  });

  test('rejects invalid empty object dynamic branches in user choices', () => {
    for (const choices of [
      '{"model_overrides":{"bad/slash":{}}}',
      '{"model_profile_overrides":{"__proto__":{}}}',
      '{"model_profile_overrides":{"custom":{}}}',
    ]) {
      const result = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
      assert.strictEqual(result.success, false, `${choices} must be rejected`);
      assert.match(result.error, /Unknown config key/);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, '.planning', 'config.json')), false);
    }
  });

  test('rejects prototype-reserved dynamic keys from defaults.json', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      '{"model_profile_overrides":{"constructor":{"opus":"owned"}}}',
      'utf-8'
    );

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key/);
    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.planning', 'config.json')), false);
  });
});

// ─── config-set (research_before_questions and discuss_mode) ──────────────────

describe('config-set research_before_questions and discuss_mode', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('workflow.research_before_questions is a valid config key', () => {
    const result = runGsdTools('config-set workflow.research_before_questions true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research_before_questions, true);
  });

  test('workflow.discuss_mode is a valid config key', () => {
    const result = runGsdTools('config-set workflow.discuss_mode assumptions', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.discuss_mode, 'assumptions');
  });

  test('research_before_questions defaults to false in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research_before_questions, false);
  });

  test('discuss_mode defaults to discuss in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.discuss_mode, 'discuss');
  });

  test('hooks.research_questions is rejected with suggestion', () => {
    const result = runGsdTools('config-set hooks.research_questions true', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
    assert.ok(
      result.error.includes('workflow.research_before_questions'),
      `Expected suggestion for workflow.research_before_questions in error: ${result.error}`
    );
  });
});

// ─── config-set (additional coverage) ────────────────────────────────────────

describe('config-set unknown key (no suggestion)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects a key that has no suggestion', () => {
    const result = runGsdTools('config-set totally.unknown.key value', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
  });
});

// ─── config-get (additional coverage) ────────────────────────────────────────

describe('config-get edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when traversing a dot-path through a non-object value', () => {
    // model_profile is a string — requesting model_profile.something traverses into a non-object
    writeConfig(tmpDir, { model_profile: 'balanced' });
    const result = runGsdTools('config-get model_profile.something', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors when config.json contains malformed JSON', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(configPath, '{not valid json', 'utf-8');
    const result = runGsdTools('config-get model_profile', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Failed to read config.json'),
      `Expected "Failed to read config.json" in error: ${result.error}`
    );
  });
});

// ─── config-set-model-profile ─────────────────────────────────────────────────

describe('config-set-model-profile command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sets a valid profile and updates config', () => {
    const result = runGsdTools('config-set-model-profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true);
    assert.strictEqual(out.profile, 'quality');
    assert.ok(out.agentToModelMap && typeof out.agentToModelMap === 'object');

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
  });

  test('reports previous profile in output', () => {
    const result = runGsdTools('config-set-model-profile budget', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.previousProfile, 'balanced'); // default was balanced
    assert.strictEqual(out.profile, 'budget');
  });

  test('setting the same profile is a no-op on config but still succeeds', () => {
    // Set to quality first, then set to quality again
    runGsdTools('config-set-model-profile quality', tmpDir);
    const result = runGsdTools('config-set-model-profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.profile, 'quality');
    assert.strictEqual(out.previousProfile, 'quality');
  });

  test('is case-insensitive', () => {
    const result = runGsdTools('config-set-model-profile BALANCED', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
  });

  test('rejects invalid profile', () => {
    const result = runGsdTools('config-set-model-profile turbo', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Invalid profile'),
      `Expected "Invalid profile" in error: ${result.error}`
    );
  });

  test('errors when no profile provided', () => {
    const result = runGsdTools('config-set-model-profile', tmpDir);
    assert.strictEqual(result.success, false);
  });

  describe('when config is missing', () => {
    let emptyDir;

    beforeEach(() => {
      emptyDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyDir);
    });

    test('creates config if missing before setting profile', () => {
      const result = runGsdTools('config-set-model-profile budget', emptyDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.model_profile, 'budget');
    });
  });
});

// ─── config-set (workflow.skip_discuss) ───────────────────────────────────────

describe('config-set workflow.skip_discuss', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('workflow.skip_discuss is a valid config key', () => {
    const result = runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, true);
  });

  test('skip_discuss defaults to false in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, false);
  });

  test('skip_discuss can be toggled back to false', () => {
    runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    const result = runGsdTools('config-set workflow.skip_discuss false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, false);
  });

  describe('skip_discuss in config-new-project', () => {
    let emptyDir;

    beforeEach(() => {
      emptyDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyDir);
    });

    test('skip_discuss is present in config-new-project output', () => {
      const result = runGsdTools(['config-new-project', '{}'], emptyDir, { HOME: emptyDir, USERPROFILE: emptyDir });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.workflow.skip_discuss, false, 'skip_discuss should default to false');
    });

    test('skip_discuss can be set via config-new-project choices', () => {
      const choices = JSON.stringify({
        workflow: { skip_discuss: true },
      });
      const result = runGsdTools(['config-new-project', choices], emptyDir, { HOME: emptyDir, USERPROFILE: emptyDir });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.workflow.skip_discuss, true);
    });
  });

  test('config-get workflow.skip_discuss returns the set value', () => {
    runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    const result = runGsdTools('config-get workflow.skip_discuss', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });
});

// ─── config-set/config-get workflow.use_worktrees ────────────────────────────

describe('config-set/config-get workflow.use_worktrees', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-get workflow.use_worktrees returns false after setting to false', () => {
    runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, false);
  });

  test('config-get workflow.use_worktrees errors when not set (default config)', () => {
    // config-ensure-section does NOT include use_worktrees in hardcoded defaults,
    // so config-get should error with "Key not found". This is the expected behavior
    // that workflows rely on: the shell fallback `|| echo "true"` provides the default.
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('config-get workflow.use_worktrees returns true after setting to true', () => {
    runGsdTools('config-set workflow.use_worktrees true', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });

  test('use_worktrees can be toggled back and forth', () => {
    runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    runGsdTools('config-set workflow.use_worktrees true', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });
});

// ─── config-set/config-get context ─────────────────────────────────────────

describe('config-set/config-get context', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config set context dev succeeds', () => {
    const result = runGsdTools('config-set context dev', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'dev');
  });

  test('config set context research succeeds', () => {
    const result = runGsdTools('config-set context research', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'research');
  });

  test('config set context review succeeds', () => {
    const result = runGsdTools('config-set context review', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'review');
  });

  test('config get context returns the set value', () => {
    runGsdTools('config-set context dev', tmpDir);
    const result = runGsdTools('config-get context', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'dev');
  });

  test('config set context rejects invalid values', () => {
    const result = runGsdTools('config-set context foobar', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Invalid context value'),
      `Expected "Invalid context value" in error: ${result.error}`
    );
  });

  test('all three context profile files exist', () => {
    const contextsDir = path.join(__dirname, '..', 'get-shit-done', 'contexts');
    assert.ok(fs.existsSync(path.join(contextsDir, 'dev.md')), 'dev.md should exist');
    assert.ok(fs.existsSync(path.join(contextsDir, 'research.md')), 'research.md should exist');
    assert.ok(fs.existsSync(path.join(contextsDir, 'review.md')), 'review.md should exist');
  });
});

// ─── config-path (#2282) ────────────────────────────────────────────────────

describe('config-path command (#2282)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns root config path when no workstream is active', () => {
    const result = runGsdTools('config-path', tmpDir);
    assert.ok(result.success, `config-path failed: ${result.error}`);
    assert.ok(result.output.trim().endsWith('.planning/config.json'), `expected root config path, got: ${result.output}`);
    assert.ok(!result.output.includes('workstreams'), 'should not include workstreams in path');
  });

  test('returns workstream config path when GSD_WORKSTREAM is set', () => {
    const result = runGsdTools('config-path', tmpDir, { GSD_WORKSTREAM: 'my-stream' });
    assert.ok(result.success, `config-path failed: ${result.error}`);
    assert.ok(result.output.trim().includes('workstreams/my-stream/config.json'), `expected workstream config path, got: ${result.output}`);
  });

  test('config-path and config-get agree on the active path', () => {
    // Write a value via config-set (uses planningDir internally)
    runGsdTools('config-set model_profile quality', tmpDir);
    // config-path should point to a file containing that value
    const pathResult = runGsdTools('config-path', tmpDir);
    const configPath = pathResult.output.trim();
    const configContent = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'));
    assert.strictEqual(configContent.model_profile, 'quality', 'config-path should point to the file config-set wrote');
  });
});
