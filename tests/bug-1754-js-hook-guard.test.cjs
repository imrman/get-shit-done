/**
 * Regression tests for bug #1754
 *
 * The installer must NOT register .js hook entries in settings.json when the
 * corresponding .js file does not exist at the target path. The original bug:
 * on fresh installs where hooks/dist/ was missing from the npm package (as in
 * v1.32.0), the hook copy step produced no files, yet the registration step
 * ran unconditionally for .js hooks — leaving users with "PreToolUse:Bash
 * hook error" on every tool invocation.
 *
 * The .sh hooks already had fs.existsSync() guards (added in #1817). This
 * test verifies the same defensive pattern exists for all .js hooks.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install, finishInstall } = require(INSTALL_SRC);
const {
  buildHookCommand,
  resolveNodeRunner,
  uninstall,
  rewriteLegacyManagedNodeHookCommands,
} = require(INSTALL_SRC);

const MANAGED_JS_HOOK_SPOOF_CASES = [
  {
    name: 'update check',
    fakeCommand: 'echo gsd-check-update',
    event: 'SessionStart',
    existingMatcher: undefined,
    managedHook: 'gsd-check-update.js',
    expectedMatcherIncludes: undefined,
  },
  {
    name: 'context monitor',
    fakeCommand: 'echo gsd-context-monitor',
    event: 'PostToolUse',
    existingMatcher: 'Read',
    managedHook: 'gsd-context-monitor.js',
    expectedMatcherIncludes: 'Bash',
  },
  {
    name: 'read guard',
    fakeCommand: 'echo gsd-read-guard',
    event: 'PreToolUse',
    existingMatcher: 'Bash',
    managedHook: 'gsd-read-guard.js',
    expectedMatcherIncludes: 'Write',
  },
  {
    name: 'workflow guard',
    fakeCommand: 'echo gsd-workflow-guard',
    event: 'PreToolUse',
    existingMatcher: 'Bash',
    managedHook: 'gsd-workflow-guard.js',
    expectedMatcherIncludes: 'Write',
  },
];

const JS_HOOKS = [
  { name: 'gsd-check-update.js',      registrationAnchor: 'hasGsdUpdateHook' },
  { name: 'gsd-context-monitor.js',   registrationAnchor: 'hasContextMonitorHook' },
  { name: 'gsd-prompt-guard.js',      registrationAnchor: 'hasPromptGuardHook' },
  { name: 'gsd-read-guard.js',        registrationAnchor: 'hasReadGuardHook' },
  { name: 'gsd-workflow-guard.js',    registrationAnchor: 'hasWorkflowGuardHook' },
];

const MANAGED_SH_HOOK_SPOOF_CASES = [
  {
    name: 'commit validation',
    fakeCommand: 'echo gsd-validate-commit',
    event: 'PreToolUse',
    managedHook: 'gsd-validate-commit.sh',
  },
  {
    name: 'session state',
    fakeCommand: '/tmp/wrapper-gsd-session-state.sh',
    event: 'SessionStart',
    managedHook: 'gsd-session-state.sh',
  },
  {
    name: 'phase boundary',
    fakeCommand: 'echo gsd-phase-boundary',
    event: 'PostToolUse',
    managedHook: 'gsd-phase-boundary.sh',
  },
];

function installWithExistingHook(t, existingHook, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-js-hook-substring-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const originalCwd = process.cwd();
  t.after(() => {
    process.chdir(originalCwd);
  });

  const settingsDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const entry = {
    hooks: [
      {
        type: 'command',
        command: existingHook.command,
      },
    ],
  };
  if (existingHook.matcher) {
    entry.matcher = existingHook.matcher;
  }
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        [existingHook.event]: [entry],
      },
    }, null, 2) + '\n'
  );

  process.chdir(tmpDir);
  const result = install(false, 'claude');
  const bannerOpts = opts.installBanner
    ? {
        shouldInstallBanner: true,
        bannerCommand: result.updateBannerCommand,
      }
    : {};
  finishInstall(
    result.settingsPath,
    result.settings,
    result.statuslineCommand,
    false,
    'claude',
    false,
    result.configDir,
    bannerOpts
  );

  return JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'));
}

function installGlobalWithExistingHook(t, existingHook) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-global-js-hook-identity-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const settingsDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const entry = {
    hooks: [
      {
        type: 'command',
        command: existingHook.command,
      },
    ],
  };
  if (existingHook.matcher) {
    entry.matcher = existingHook.matcher;
  }
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        [existingHook.event]: [entry],
      },
    }, null, 2) + '\n'
  );

  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
  });
  process.env.CLAUDE_CONFIG_DIR = settingsDir;

  const result = install(true, 'claude');
  finishInstall(
    result.settingsPath,
    result.settings,
    result.statuslineCommand,
    false,
    'claude',
    true,
    result.configDir
  );

  return {
    settingsDir,
    settings: JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8')),
  };
}

function hookCommands(settings, event) {
  return (settings.hooks[event] || []).flatMap((entry) =>
    Array.isArray(entry.hooks) ? entry.hooks.map((hook) => hook.command).filter(Boolean) : []
  );
}

function entriesWithManagedHook(settings, event, managedHook) {
  const managedPath = `/hooks/${managedHook}`;
  return (settings.hooks[event] || []).filter((entry) =>
    Array.isArray(entry.hooks) && entry.hooks.some((hook) =>
      typeof hook.command === 'string' && hook.command.includes(managedPath)
    )
  );
}

describe('bug #1754: .js hook registration guards', () => {
  let src;

  before(() => {
    execFileSync(process.execPath, [BUILD_SCRIPT], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    src = fs.readFileSync(INSTALL_SRC, 'utf-8');
  });

  for (const { name, registrationAnchor } of JS_HOOKS) {
    describe(`${name} registration`, () => {
      test(`install.js checks file existence before registering ${name}`, () => {
        // Find the registration block by locating the "has...Hook" variable
        const anchorIdx = src.indexOf(registrationAnchor);
        assert.ok(
          anchorIdx !== -1,
          `${registrationAnchor} variable not found in install.js`
        );

        // Extract a window around the registration block to find the guard
        const blockStart = anchorIdx;
        const blockEnd = Math.min(src.length, anchorIdx + 1200);
        const block = src.slice(blockStart, blockEnd);

        // The block must contain an fs.existsSync check for the hook file
        assert.ok(
          block.includes('fs.existsSync') || block.includes('existsSync'),
          `install.js must call fs.existsSync on the target path before registering ${name} ` +
          `in settings.json. Without this guard, hooks are registered even when the .js file ` +
          `was never copied (the root cause of #1754).`
        );
      });

      test(`install.js emits a warning when ${name} is missing`, () => {
        // The hook file name (without extension) should appear in a warning message
        const hookBaseName = name.replace('.js', '');
        const warnPattern = `Skipped`;
        const anchorIdx = src.indexOf(registrationAnchor);
        const block = src.slice(anchorIdx, Math.min(src.length, anchorIdx + 1200));

        assert.ok(
          block.includes(warnPattern) && block.includes(hookBaseName),
          `install.js must emit a skip warning when ${name} is not found at the target path`
        );
      });
    });
  }

  test('all .js hooks use the same guard pattern as .sh hooks', () => {
    // Count existsSync calls in the hook registration section.
    // There should be guards for all JS hooks plus the existing SH hooks.
    // This test ensures new hooks added in the future follow the same pattern.
    const registrationSection = src.slice(
      src.indexOf('// Configure SessionStart hook'),
      src.indexOf('return { settingsPath, settings, statuslineCommand')
    );

    // Count unique hook file existence checks (pattern: path.join(targetDir, 'hooks', 'gsd-*.js'))
    const jsGuards = (registrationSection.match(/gsd-[\w-]+\.js.*not found at target/g) || []);
    const shGuards = (registrationSection.match(/gsd-[\w-]+\.sh.*not found at target/g) || []);

    assert.ok(
      jsGuards.length >= JS_HOOKS.length,
      `Expected at least ${JS_HOOKS.length} .js hook guards, found ${jsGuards.length}. ` +
      `Every .js hook registration must check file existence before registering.`
    );

    assert.ok(
      shGuards.length >= 3,
      `Expected at least 3 .sh hook guards (validate-commit, session-state, phase-boundary), ` +
      `found ${shGuards.length}.`
    );
  });

  test('prompt guard registration includes MultiEdit in the matcher', () => {
    const anchorIdx = src.indexOf('hasPromptGuardHook');
    assert.ok(anchorIdx !== -1, 'hasPromptGuardHook variable not found in install.js');

    const block = src.slice(anchorIdx, Math.min(src.length, anchorIdx + 1600));
    assert.ok(
      block.includes("matcher: 'Write|Edit|MultiEdit'") || block.includes('Write|Edit|MultiEdit'),
      'prompt guard must be registered for MultiEdit as well as Write/Edit so batch edits to .planning/ are scanned'
    );
  });

  test('global prompt guard registration is not suppressed by a relative managed-hook alias', (t) => {
    const { settingsDir, settings } = installGlobalWithExistingHook(t, {
      event: 'PreToolUse',
      matcher: 'Write|Edit',
      command: 'node .claude/hooks/gsd-prompt-guard.js',
    });
    const commands = hookCommands(settings, 'PreToolUse');
    const normalizedSettingsDir = settingsDir.replace(/\\/g, '/');
    const absolutePromptGuardCommands = commands.filter((command) =>
      command.includes(`${normalizedSettingsDir}/hooks/gsd-prompt-guard.js`)
    );

    assert.equal(
      absolutePromptGuardCommands.length,
      1,
      'global install must add the real absolute prompt guard even when a relative alias already exists'
    );
  });

  test('global Claude hook copy replaces a pre-existing hook symlink without overwriting its target', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-claude-hook-symlink-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const settingsDir = path.join(tmpDir, '.claude');
    const hooksDir = path.join(settingsDir, 'hooks');
    const victimPath = path.join(tmpDir, 'victim.txt');
    const hookPath = path.join(hooksDir, 'gsd-prompt-guard.js');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(victimPath, 'do not overwrite\n');
    fs.symlinkSync(victimPath, hookPath);

    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    t.after(() => {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
    });
    process.env.CLAUDE_CONFIG_DIR = settingsDir;

    const result = install(true, 'claude');
    finishInstall(
      result.settingsPath,
      result.settings,
      result.statuslineCommand,
      false,
      'claude',
      true,
      result.configDir
    );

    assert.equal(fs.readFileSync(victimPath, 'utf8'), 'do not overwrite\n');
    assert.equal(fs.lstatSync(hookPath).isSymbolicLink(), false, 'installed hook must be a regular file, not the attacker symlink');
    assert.match(fs.readFileSync(hookPath, 'utf8'), /GSD Prompt Injection Guard/);
  });

  test('global Claude hook copy refuses a symlinked hooks directory', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-claude-hooks-dir-symlink-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const settingsDir = path.join(tmpDir, '.claude');
    const externalHooksDir = path.join(tmpDir, 'external-hooks');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.mkdirSync(externalHooksDir, { recursive: true });
    fs.symlinkSync(externalHooksDir, path.join(settingsDir, 'hooks'), 'dir');

    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    t.after(() => {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
    });
    process.env.CLAUDE_CONFIG_DIR = settingsDir;

    assert.throws(
      () => install(true, 'claude'),
      /Refusing to install hooks into symlinked directory/
    );
    assert.deepEqual(fs.readdirSync(externalHooksDir), [], 'installer must not write hooks through the symlinked directory');
  });

  test('local prompt guard migration still treats project-relative aliases as managed', (t) => {
    const settings = installWithExistingHook(t, {
      event: 'PreToolUse',
      matcher: 'Write|Edit',
      command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-prompt-guard.js',
    });
    const commands = hookCommands(settings, 'PreToolUse');
    const managedPromptGuardCommands = commands.filter((command) =>
      command.includes('/hooks/gsd-prompt-guard.js')
    );

    assert.equal(
      managedPromptGuardCommands.length,
      1,
      'local install must keep project-relative prompt guard aliases idempotent'
    );
    assert.equal(
      managedPromptGuardCommands[0],
      `${resolveNodeRunner()} "$CLAUDE_PROJECT_DIR"'/.claude/hooks/gsd-prompt-guard.js'`,
      'migration must preserve the expanding "$CLAUDE_PROJECT_DIR" prefix and quote only the inert suffix'
    );
  });

  test('legacy rewrite preserves a user-owned same-basename prompt guard command', (t) => {
    const userOwnedCommand = 'node /tmp/user/hooks/gsd-prompt-guard.js';
    const settings = installWithExistingHook(t, {
      event: 'PreToolUse',
      matcher: 'Write|Edit',
      command: userOwnedCommand,
    });
    const commands = hookCommands(settings, 'PreToolUse');
    const managedPromptGuardCommands = commands.filter((command) =>
      command.includes('/hooks/gsd-prompt-guard.js')
    );

    assert.ok(commands.includes(userOwnedCommand), 'user-owned same-basename prompt guard must stay unchanged');
    assert.equal(
      managedPromptGuardCommands.filter((command) => command !== userOwnedCommand).length,
      1,
      'installer must still add the real managed prompt guard alongside the preserved user hook'
    );
  });

  test('legacy rewrite recognizes global portable managed prompt guard commands', () => {
    const targetDir = path.join(os.homedir(), '.claude');
    const portableCommand = buildHookCommand(targetDir, 'gsd-prompt-guard.js', {
      portableHooks: true,
      absoluteRunner: 'node',
    });
    const absoluteRunner = "'/usr/local/bin/node'";
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [
              {
                type: 'command',
                command: portableCommand,
              },
            ],
          },
        ],
      },
    };

    const changed = rewriteLegacyManagedNodeHookCommands(settings, absoluteRunner, {
      targetDir,
      dirName: '.claude',
      isGlobal: true,
    });

    assert.equal(changed, true);
    assert.strictEqual(
      settings.hooks.PreToolUse[0].hooks[0].command,
      `${absoluteRunner} "$HOME"'/.claude/hooks/gsd-prompt-guard.js'`,
      'portable global managed hook should migrate to the absolute runner without duplicating ownership'
    );
  });

  for (const spoofCase of MANAGED_JS_HOOK_SPOOF_CASES) {
    test(`a non-managed command mentioning ${spoofCase.managedHook} does not suppress the real ${spoofCase.name} hook`, (t) => {
      const settings = installWithExistingHook(t, {
        event: spoofCase.event,
        matcher: spoofCase.existingMatcher,
        command: spoofCase.fakeCommand,
      });
      const commands = hookCommands(settings, spoofCase.event);
      const managedCommands = commands.filter((command) =>
        command.includes(`/hooks/${spoofCase.managedHook}`)
      );

      assert.ok(commands.includes(spoofCase.fakeCommand), 'user-authored hook must be preserved');
      assert.equal(
        managedCommands.length,
        1,
        `installer must add the real managed ${spoofCase.managedHook} hook even when a user hook only mentions its name`
      );

      if (spoofCase.expectedMatcherIncludes) {
        const [managedEntry] = entriesWithManagedHook(settings, spoofCase.event, spoofCase.managedHook);
        assert.ok(managedEntry, `managed ${spoofCase.managedHook} entry must exist`);
        assert.ok(
          managedEntry.matcher.split('|').includes(spoofCase.expectedMatcherIncludes),
          `managed ${spoofCase.managedHook} matcher must include ${spoofCase.expectedMatcherIncludes}`
        );
      }
    });
  }

  test('context monitor migration ignores non-managed spoof hooks', (t) => {
    const fakeCommand = 'echo gsd-context-monitor';
    const settings = installWithExistingHook(t, {
      event: 'PostToolUse',
      command: fakeCommand,
    });
    const fakeEntry = settings.hooks.PostToolUse.find((entry) =>
      Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook.command === fakeCommand)
    );
    const [managedEntry] = entriesWithManagedHook(settings, 'PostToolUse', 'gsd-context-monitor.js');

    assert.ok(fakeEntry, 'user-authored hook must be preserved');
    assert.equal(fakeEntry.matcher, undefined, 'non-managed spoof hook must not receive managed matcher migration');
    assert.equal(fakeEntry.hooks[0].timeout, undefined, 'non-managed spoof hook must not receive managed timeout migration');
    assert.ok(managedEntry, 'real managed context monitor hook must be installed');
    assert.ok(
      managedEntry.matcher.split('|').includes('Bash'),
      'real managed context monitor hook must receive managed matcher'
    );
    assert.equal(managedEntry.hooks[0].timeout, 10, 'real managed context monitor hook must receive timeout');
  });

  test('a non-managed command mentioning gsd-update-banner does not suppress the opt-in managed update banner hook', (t) => {
    const fakeCommand = 'echo gsd-update-banner';
    const settings = installWithExistingHook(t, {
      event: 'SessionStart',
      command: fakeCommand,
    }, {
      installBanner: true,
    });
    const commands = hookCommands(settings, 'SessionStart');
    const managedBannerCommands = commands.filter((command) =>
      command.includes('/hooks/gsd-update-banner.js')
    );

    assert.ok(commands.includes(fakeCommand), 'user-authored hook must be preserved');
    assert.equal(
      managedBannerCommands.length,
      1,
      'installer must add the opt-in managed gsd-update-banner.js hook even when a user hook only mentions its name'
    );
  });

  test('a non-managed command mentioning gsd-prompt-guard does not suppress the real prompt guard', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prompt-guard-substring-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const originalCwd = process.cwd();
    t.after(() => {
      process.chdir(originalCwd);
    });

    const settingsDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    const fakeCommand = 'echo gsd-prompt-guard';
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: fakeCommand,
                },
              ],
            },
          ],
        },
      }, null, 2) + '\n'
    );

    process.chdir(tmpDir);
    const result = install(false, 'claude');
    finishInstall(
      result.settingsPath,
      result.settings,
      result.statuslineCommand,
      false,
      'claude',
      false
    );

    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'));
    const preToolEntries = settings.hooks.PreToolUse;
    const commands = preToolEntries.flatMap((entry) =>
      Array.isArray(entry.hooks) ? entry.hooks.map((hook) => hook.command).filter(Boolean) : []
    );
    const managedPromptGuardCommands = commands.filter((command) =>
      command.includes('/hooks/gsd-prompt-guard.js')
    );

    assert.ok(commands.includes(fakeCommand), 'user-authored hook must be preserved');
    assert.equal(
      managedPromptGuardCommands.length,
      1,
      'installer must add the real managed gsd-prompt-guard.js hook even when a user hook only mentions its name'
    );

    const managedPromptGuardEntry = preToolEntries.find((entry) =>
      Array.isArray(entry.hooks) && entry.hooks.some((hook) =>
        typeof hook.command === 'string' && hook.command.includes('/hooks/gsd-prompt-guard.js')
      )
    );
    assert.ok(
      managedPromptGuardEntry.matcher.split('|').includes('MultiEdit'),
      'managed prompt guard matcher must cover MultiEdit'
    );
  });

  test('a non-managed command mentioning gsd-read-injection-scanner does not suppress the real read scanner', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-read-scanner-substring-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const originalCwd = process.cwd();
    t.after(() => {
      process.chdir(originalCwd);
    });

    const settingsDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    const fakeCommand = 'echo gsd-read-injection-scanner';
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Read',
              hooks: [
                {
                  type: 'command',
                  command: fakeCommand,
                },
              ],
            },
          ],
        },
      }, null, 2) + '\n'
    );

    process.chdir(tmpDir);
    const result = install(false, 'claude');
    finishInstall(
      result.settingsPath,
      result.settings,
      result.statuslineCommand,
      false,
      'claude',
      false
    );

    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'));
    const postToolEntries = settings.hooks.PostToolUse;
    const commands = postToolEntries.flatMap((entry) =>
      Array.isArray(entry.hooks) ? entry.hooks.map((hook) => hook.command).filter(Boolean) : []
    );
    const managedReadScannerCommands = commands.filter((command) =>
      command.includes('/hooks/gsd-read-injection-scanner.js')
    );

    assert.ok(commands.includes(fakeCommand), 'user-authored hook must be preserved');
    assert.equal(
      managedReadScannerCommands.length,
      1,
      'installer must add the real managed gsd-read-injection-scanner.js hook even when a user hook only mentions its name'
    );
  });

  for (const spoofCase of MANAGED_SH_HOOK_SPOOF_CASES) {
    test(`a non-managed command mentioning ${spoofCase.managedHook} does not suppress the real ${spoofCase.name} hook`, (t) => {
      const settings = installWithExistingHook(t, {
        event: spoofCase.event,
        command: spoofCase.fakeCommand,
      });
      const commands = hookCommands(settings, spoofCase.event);
      const managedCommands = commands.filter((command) =>
        command.includes(`/hooks/${spoofCase.managedHook}`)
      );

      assert.ok(commands.includes(spoofCase.fakeCommand), 'user-authored hook must be preserved');
      assert.equal(
        managedCommands.length,
        1,
        `installer must add the real managed ${spoofCase.managedHook} hook even when a user hook only mentions its name`
      );
    });
  }

  test('uninstall preserves user-owned hooks that only mention GSD names while removing managed hooks', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uninstall-hook-identity-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const settingsDir = path.join(tmpDir, '.claude');
    const hooksDir = path.join(settingsDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const hook of ['gsd-prompt-guard.js', 'gsd-read-injection-scanner.js', 'gsd-validate-commit.sh']) {
      fs.writeFileSync(path.join(hooksDir, hook), '# managed hook placeholder\n');
    }

    const fakeCommands = [
      'echo gsd-prompt-guard',
      'echo gsd-read-injection-scanner',
      'echo gsd-validate-commit',
    ];
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: fakeCommands[0] },
                { type: 'command', command: `node ${settingsDir}/hooks/gsd-prompt-guard.js` },
                { type: 'command', command: `bash ${settingsDir}/hooks/gsd-validate-commit.sh` },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                { type: 'command', command: fakeCommands[1] },
                { type: 'command', command: `node ${settingsDir}/hooks/gsd-read-injection-scanner.js` },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: fakeCommands[2] },
              ],
            },
          ],
        },
      }, null, 2) + '\n'
    );

    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    t.after(() => {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
    });
    process.env.CLAUDE_CONFIG_DIR = settingsDir;

    uninstall(true, 'claude');

    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'));
    const commands = ['PreToolUse', 'PostToolUse', 'SessionStart'].flatMap((event) =>
      hookCommands(settings, event)
    );

    for (const fakeCommand of fakeCommands) {
      assert.ok(commands.includes(fakeCommand), `${fakeCommand} must be preserved`);
    }
    assert.ok(
      commands.every((command) => !command.includes(`${settingsDir}/hooks/gsd-`)),
      'managed hook commands under targetDir must be removed'
    );
  });

  test('uninstall does not follow a symlinked hooks directory to delete outside files', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uninstall-hooks-dir-symlink-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const settingsDir = path.join(tmpDir, '.claude');
    const externalHooksDir = path.join(tmpDir, 'external-hooks');
    const externalHook = path.join(externalHooksDir, 'gsd-prompt-guard.js');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.mkdirSync(externalHooksDir, { recursive: true });
    fs.writeFileSync(externalHook, '# user-owned external hook\n');
    fs.symlinkSync(externalHooksDir, path.join(settingsDir, 'hooks'), 'dir');

    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    t.after(() => {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
    });
    process.env.CLAUDE_CONFIG_DIR = settingsDir;

    uninstall(true, 'claude');

    assert.equal(
      fs.readFileSync(externalHook, 'utf8'),
      '# user-owned external hook\n',
      'uninstall must not unlink GSD-named files through a symlinked hooks directory'
    );
  });

  test('uninstall preserves user-owned statusLine commands that only mention gsd-statusline while removing managed statusLine hooks', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uninstall-statusline-identity-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const settingsDir = path.join(tmpDir, '.claude');
    const hooksDir = path.join(settingsDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gsd-statusline.js'), '# managed hook placeholder\n');

    const settingsPath = path.join(settingsDir, 'settings.json');
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    t.after(() => {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
    });
    process.env.CLAUDE_CONFIG_DIR = settingsDir;

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'echo gsd-statusline',
        },
      }, null, 2) + '\n'
    );

    uninstall(true, 'claude');

    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.deepEqual(
      settings.statusLine,
      {
        type: 'command',
        command: 'echo gsd-statusline',
      },
      'user-owned statusLine command must be preserved'
    );

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: `node ${settingsDir}/hooks/gsd-statusline.js`,
        },
      }, null, 2) + '\n'
    );

    uninstall(true, 'claude');

    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.equal(settings.statusLine, undefined, 'managed statusLine hook must be removed');
  });
});
