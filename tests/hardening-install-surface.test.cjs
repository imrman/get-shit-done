/**
 * Hardening regressions for forked Codex install behavior.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { install } = require('../bin/install.js');

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_SRC = path.join(REPO_ROOT, 'bin', 'install.js');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('fork hardening regressions', () => {
  test('agent prompts do not instruct runtime npm execution for ctx7 fallback', () => {
    const agentFiles = fs.readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md'));
    const offenders = [];

    for (const file of agentFiles) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
      if (content.includes('ctx7@latest')) {
        offenders.push(file);
      }
    }

    assert.deepStrictEqual(
      offenders,
      [],
      `agent prompts must not invoke ctx7 from npm at runtime: ${offenders.join(', ')}`
    );
  });

  test('default installer source keeps SDK install opt-in only', () => {
    const src = fs.readFileSync(INSTALL_SRC, 'utf8');

    assert.ok(src.includes("args.includes('--sdk')"), '--sdk flag should remain supported');
    assert.ok(src.includes("args.includes('--no-sdk')"), '--no-sdk flag should remain supported');
    assert.ok(
      src.includes('Skipping GSD SDK install (default; use --sdk to enable)'),
      'installer should skip SDK work unless --sdk is explicitly requested'
    );
  });

  test('codex install does not inject GSD update hooks into config.toml', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-hardening-'));
    const fakeHome = path.join(tempRoot, 'home');
    const codexHome = path.join(tempRoot, 'codex-home');
    fs.mkdirSync(fakeHome, { recursive: true });

    try {
      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: codexHome }, () => {
        const previousCwd = process.cwd();
        try {
          process.chdir(REPO_ROOT);
          install(true, 'codex');
        } finally {
          process.chdir(previousCwd);
        }
      });

      const configPath = path.join(codexHome, 'config.toml');
      const content = fs.readFileSync(configPath, 'utf8');

      assert.ok(!content.includes('gsd-check-update.js'), 'config.toml should not reference the update hook');
      assert.ok(!content.includes('event = "SessionStart"'), 'config.toml should not register a SessionStart hook');
      assert.ok(!content.includes('codex_hooks = true'), 'config.toml should not enable codex_hooks by default');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('codex install does not write ~/.gsd/defaults.json as a side effect', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-home-hardening-'));
    const fakeHome = path.join(tempRoot, 'home');
    const codexHome = path.join(tempRoot, 'codex-home');
    fs.mkdirSync(fakeHome, { recursive: true });

    try {
      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: codexHome }, () => {
        const previousCwd = process.cwd();
        try {
          process.chdir(REPO_ROOT);
          install(true, 'codex');
        } finally {
          process.chdir(previousCwd);
        }
      });

      assert.ok(
        !fs.existsSync(path.join(fakeHome, '.gsd', 'defaults.json')),
        'install should not create ~/.gsd/defaults.json'
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
