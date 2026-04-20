/**
 * GSD Tools Tests - codex-config.cjs
 *
 * Tests for Codex adapter header, agent conversion, config.toml generation/merge,
 * per-agent .toml generation, and uninstall cleanup.
 */

// Enable test exports from install.js (skips main CLI logic)
process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  getCodexSkillAdapterHeader,
  convertClaudeAgentToCodexAgent,
  convertClaudeCommandToCodexSkill,
  generateCodexAgentToml,
  generateCodexConfigBlock,
  stripGsdFromCodexConfig,
  mergeCodexConfig,
  install,
  GSD_CODEX_MARKER,
  CODEX_AGENT_SANDBOX,
} = require('../bin/install.js');

function runCodexInstall(codexHome, cwd = path.join(__dirname, '..')) {
  const previousCodeHome = process.env.CODEX_HOME;
  const previousCwd = process.cwd();
  process.env.CODEX_HOME = codexHome;

  try {
    process.chdir(cwd);
    return install(true, 'codex');
  } finally {
    process.chdir(previousCwd);
    if (previousCodeHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodeHome;
    }
  }
}

function readCodexConfig(codexHome) {
  return fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
}

function writeCodexConfig(codexHome, content) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
}

function countMatches(content, pattern) {
  return (content.match(pattern) || []).length;
}

function assertNoDraftRootKeys(content) {
  assert.ok(!content.includes('model = "gpt-5.4"'), 'does not inject draft model default');
  assert.ok(!content.includes('model_reasoning_effort = "high"'), 'does not inject draft reasoning default');
  assert.ok(!content.includes('disable_response_storage = true'), 'does not inject draft storage default');
}

function assertUsesOnlyEol(content, eol) {
  if (eol === '\r\n') {
    assert.ok(content.includes('\r\n'), 'contains CRLF line endings');
    assert.ok(!content.replace(/\r\n/g, '').includes('\n'), 'does not contain bare LF line endings');
    return;
  }
  assert.ok(!content.includes('\r\n'), 'does not contain CRLF line endings');
}

// ─── getCodexSkillAdapterHeader ─────────────────────────────────────────────────

describe('getCodexSkillAdapterHeader', () => {
  test('contains all three sections', () => {
    const result = getCodexSkillAdapterHeader('gsd-execute-phase');
    assert.ok(result.includes('<codex_skill_adapter>'), 'has opening tag');
    assert.ok(result.includes('</codex_skill_adapter>'), 'has closing tag');
    assert.ok(result.includes('## A. Skill Invocation'), 'has section A');
    assert.ok(result.includes('## B. AskUserQuestion'), 'has section B');
    assert.ok(result.includes('## C. Task() → spawn_agent'), 'has section C');
  });

  test('includes correct invocation syntax', () => {
    const result = getCodexSkillAdapterHeader('gsd-plan-phase');
    assert.ok(result.includes('`$gsd-plan-phase`'), 'has $skillName invocation');
    assert.ok(result.includes('{{GSD_ARGS}}'), 'has GSD_ARGS variable');
  });

  test('section B maps AskUserQuestion parameters', () => {
    const result = getCodexSkillAdapterHeader('gsd-discuss-phase');
    assert.ok(result.includes('request_user_input'), 'maps to request_user_input');
    assert.ok(result.includes('header'), 'maps header parameter');
    assert.ok(result.includes('question'), 'maps question parameter');
    assert.ok(result.includes('label'), 'maps options label');
    assert.ok(result.includes('description'), 'maps options description');
    assert.ok(result.includes('multiSelect'), 'documents multiSelect workaround');
    assert.ok(result.includes('Execute mode'), 'documents Execute mode fallback');
  });

  test('section C maps Task to spawn_agent', () => {
    const result = getCodexSkillAdapterHeader('gsd-execute-phase');
    assert.ok(result.includes('spawn_agent'), 'maps to spawn_agent');
    assert.ok(result.includes('agent_type'), 'maps subagent_type to agent_type');
    assert.ok(result.includes('fork_context'), 'documents fork_context default');
    assert.ok(result.includes('wait(ids)'), 'documents parallel wait pattern');
    assert.ok(result.includes('close_agent'), 'documents close_agent cleanup');
    assert.ok(result.includes('CHECKPOINT'), 'documents result markers');
  });
});

// ─── convertClaudeAgentToCodexAgent ─────────────────────────────────────────────

describe('convertClaudeAgentToCodexAgent', () => {
  test('adds codex_agent_role header and cleans frontmatter', () => {
    const input = `---
name: gsd-executor
description: Executes GSD plans with atomic commits
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
---

<role>
You are a GSD plan executor.
</role>`;

    const result = convertClaudeAgentToCodexAgent(input);

    // Frontmatter rebuilt with only name and description
    assert.ok(result.startsWith('---\n'), 'starts with frontmatter');
    assert.ok(result.includes('"gsd-executor"'), 'has quoted name');
    assert.ok(result.includes('"Executes GSD plans with atomic commits"'), 'has quoted description');
    assert.ok(!result.includes('color: yellow'), 'drops color field');
    // Tools should be in <codex_agent_role> but NOT in frontmatter
    const fmEnd = result.indexOf('---', 4);
    const frontmatterSection = result.substring(0, fmEnd);
    assert.ok(!frontmatterSection.includes('tools:'), 'drops tools from frontmatter');

    // Has codex_agent_role block
    assert.ok(result.includes('<codex_agent_role>'), 'has role header');
    assert.ok(result.includes('role: gsd-executor'), 'role matches agent name');
    assert.ok(result.includes('tools: Read, Write, Edit, Bash, Grep, Glob'), 'tools in role block');
    assert.ok(result.includes('purpose: Executes GSD plans with atomic commits'), 'purpose from description');
    assert.ok(result.includes('</codex_agent_role>'), 'has closing tag');

    // Body preserved
    assert.ok(result.includes('<role>'), 'body content preserved');
  });

  test('converts slash commands in body', () => {
    const input = `---
name: gsd-test
description: Test agent
tools: Read
---

Run /gsd:execute-phase to proceed.`;

    const result = convertClaudeAgentToCodexAgent(input);
    assert.ok(result.includes('$gsd-execute-phase'), 'converts slash commands');
    assert.ok(!result.includes('/gsd:execute-phase'), 'original slash command removed');
  });

  test('handles content without frontmatter', () => {
    const input = 'Just some content without frontmatter.';
    const result = convertClaudeAgentToCodexAgent(input);
    assert.strictEqual(result, input, 'returns input unchanged');
  });

  test('replaces .claude paths with .codex paths (#1430)', () => {
    const input = `---
name: gsd-debugger
description: Debugs issues
tools: Read, Bash
---

INIT=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state load)
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" commit "docs: resolve"`;

    const result = convertClaudeAgentToCodexAgent(input);
    assert.ok(result.includes('$HOME/.codex/get-shit-done/bin/gsd-tools.cjs'), 'replaces $HOME/.claude/ with $HOME/.codex/');
    assert.ok(!result.includes('$HOME/.claude/'), 'no .claude paths remain');
  });
});

// ─── Codex command prefix conversion ────────────────────────────────────────────

describe('Codex hyphen-style command prefix conversion', () => {
  test('converts /gsd-command in workflow output to $gsd-command', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

/gsd-discuss-phase 1 — gather context
/gsd-plan-phase 2 — create plan
/gsd-execute-phase 3 — run it`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('$gsd-discuss-phase'), 'converts /gsd-discuss-phase');
    assert.ok(result.includes('$gsd-plan-phase'), 'converts /gsd-plan-phase');
    assert.ok(result.includes('$gsd-execute-phase'), 'converts /gsd-execute-phase');
    assert.ok(!result.includes('/gsd-discuss-phase'), 'no /gsd-discuss-phase remains');
  });

  test('converts backtick-wrapped /gsd- commands', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

Run \`/gsd-plan-phase 1\` to plan.`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('$gsd-plan-phase'), 'converts backtick-wrapped command');
  });

  test('does not convert /gsd- in file paths', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" init`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('gsd-tools.cjs'), 'gsd-tools.cjs preserved in path');
    assert.ok(!result.includes('$gsd-tools'), 'no $gsd-tools in file path');
  });

  test('removes /clear then: for Codex', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

\`/clear\` then:

\`$gsd-plan-phase 1\``;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(!result.includes('/clear'), 'no /clear remains');
    assert.ok(result.includes('$gsd-plan-phase'), 'command preserved after /clear removal');
  });

  test('removes bare /clear then: for Codex', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

/clear then:
/gsd-execute-phase 2`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(!result.includes('/clear'), 'no /clear remains');
    assert.ok(result.includes('$gsd-execute-phase'), 'command converted');
  });
});

// ─── generateCodexAgentToml ─────────────────────────────────────────────────────

describe('generateCodexAgentToml', () => {
  const sampleAgent = `---
name: gsd-executor
description: Executes plans
tools: Read, Write, Edit
color: yellow
---

<role>You are an executor.</role>`;

  test('sets workspace-write for executor', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes('sandbox_mode = "workspace-write"'), 'has workspace-write');
  });

  test('sets read-only for plan-checker', () => {
    const checker = `---
name: gsd-plan-checker
description: Checks plans
tools: Read, Grep, Glob
---

<role>You check plans.</role>`;
    const result = generateCodexAgentToml('gsd-plan-checker', checker);
    assert.ok(result.includes('sandbox_mode = "read-only"'), 'has read-only');
  });

  test('includes developer_instructions from body', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes("developer_instructions = '''"), 'has literal triple-quoted instructions');
    assert.ok(result.includes('<role>You are an executor.</role>'), 'body content in instructions');
    assert.ok(result.includes("'''"), 'has closing literal triple quotes');
  });

  test('includes required name and description fields', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes('name = "gsd-executor"'), 'has name');
    assert.ok(result.includes('description = "Executes plans"'), 'has description');
  });

  test('falls back to generated description when frontmatter is missing fields', () => {
    const minimalAgent = `<role>You are an unknown agent.</role>`;
    const result = generateCodexAgentToml('gsd-unknown', minimalAgent);
    assert.ok(result.includes('name = "gsd-unknown"'), 'falls back to agent name');
    assert.ok(result.includes('description = "GSD agent gsd-unknown"'), 'falls back to synthetic description');
  });

  test('defaults unknown agents to read-only', () => {
    const result = generateCodexAgentToml('gsd-unknown', sampleAgent);
    assert.ok(result.includes('sandbox_mode = "read-only"'), 'defaults to read-only');
  });

  // ─── #2256: model_overrides support ───────────────────────────────────────

  test('emits model field when modelOverrides contains an entry for the agent (#2256)', () => {
    const overrides = { 'gsd-executor': 'gpt-5.3-codex' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    assert.ok(result.includes('model = "gpt-5.3-codex"'), 'model field must be present in TOML');
  });

  test('does not emit model field when modelOverrides is null (#2256)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null);
    assert.ok(!result.includes('model ='), 'model field must be absent when no override');
  });

  test('does not emit model field when modelOverrides has no entry for this agent (#2256)', () => {
    const overrides = { 'gsd-planner': 'gpt-5.4' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    assert.ok(!result.includes('model ='), 'model field must be absent for agents not in overrides');
  });

  test('model field appears before developer_instructions (#2256)', () => {
    const overrides = { 'gsd-executor': 'gpt-5.3-codex' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    const modelIdx = result.indexOf('model = "gpt-5.3-codex"');
    const instrIdx = result.indexOf("developer_instructions = '''");
    assert.ok(modelIdx !== -1, 'model field present');
    assert.ok(instrIdx !== -1, 'developer_instructions present');
    assert.ok(modelIdx < instrIdx, 'model field must appear before developer_instructions');
  });
});

// ─── CODEX_AGENT_SANDBOX mapping ────────────────────────────────────────────────

describe('CODEX_AGENT_SANDBOX', () => {
  test('has all 11 agents mapped', () => {
    const agentNames = Object.keys(CODEX_AGENT_SANDBOX);
    assert.strictEqual(agentNames.length, 11, 'has 11 agents');
  });

  test('workspace-write agents have write tools', () => {
    const writeAgents = [
      'gsd-executor', 'gsd-planner', 'gsd-phase-researcher',
      'gsd-project-researcher', 'gsd-research-synthesizer', 'gsd-verifier',
      'gsd-codebase-mapper', 'gsd-roadmapper', 'gsd-debugger',
    ];
    for (const name of writeAgents) {
      assert.strictEqual(CODEX_AGENT_SANDBOX[name], 'workspace-write', `${name} is workspace-write`);
    }
  });

  test('read-only agents have no write tools', () => {
    const readOnlyAgents = ['gsd-plan-checker', 'gsd-integration-checker'];
    for (const name of readOnlyAgents) {
      assert.strictEqual(CODEX_AGENT_SANDBOX[name], 'read-only', `${name} is read-only`);
    }
  });
});

// ─── generateCodexConfigBlock ───────────────────────────────────────────────────

describe('generateCodexConfigBlock', () => {
  const agents = [
    { name: 'gsd-executor', description: 'Executes plans' },
    { name: 'gsd-planner', description: 'Creates plans' },
  ];

  test('starts with GSD marker', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(result.startsWith(GSD_CODEX_MARKER), 'starts with marker');
  });

  test('does not include feature flags or agents table header', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(!result.includes('[features]'), 'no features table');
    assert.ok(!result.includes('multi_agent'), 'no multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'no request_user_input');
    // Should not have bare [agents] table header (only [agents.gsd-*] sections)
    assert.ok(!result.match(/^\[agents\]\s*$/m), 'no bare [agents] table');
    assert.ok(!result.includes('max_threads'), 'no max_threads');
    assert.ok(!result.includes('max_depth'), 'no max_depth');
  });

  test('includes per-agent sections with relative paths (no targetDir)', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(result.includes('[agents.gsd-executor]'), 'has executor section');
    assert.ok(result.includes('[agents.gsd-planner]'), 'has planner section');
    assert.ok(result.includes('config_file = "agents/gsd-executor.toml"'), 'relative config_file without targetDir');
    assert.ok(result.includes('"Executes plans"'), 'has executor description');
  });

  test('uses absolute config_file paths when targetDir is provided', () => {
    const result = generateCodexConfigBlock(agents, '/home/user/.codex');
    assert.ok(result.includes('config_file = "/home/user/.codex/agents/gsd-executor.toml"'), 'absolute executor path');
    assert.ok(result.includes('config_file = "/home/user/.codex/agents/gsd-planner.toml"'), 'absolute planner path');
    assert.ok(!result.includes('config_file = "agents/'), 'no relative paths when targetDir given');
  });
});

// ─── stripGsdFromCodexConfig ────────────────────────────────────────────────────

describe('stripGsdFromCodexConfig', () => {
  test('returns null for GSD-only config', () => {
    const content = `${GSD_CODEX_MARKER}\n[features]\nmulti_agent = true\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.strictEqual(result, null, 'returns null when GSD-only');
  });

  test('preserves user content before marker', () => {
    const content = `[model]\nname = "o3"\n\n${GSD_CODEX_MARKER}\n[features]\nmulti_agent = true\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(result.includes('[model]'), 'preserves user section');
    assert.ok(result.includes('name = "o3"'), 'preserves user values');
    assert.ok(!result.includes('multi_agent'), 'removes GSD content');
    assert.ok(!result.includes(GSD_CODEX_MARKER), 'removes marker');
  });

  test('strips injected feature keys without marker', () => {
    const content = `[features]\nmulti_agent = true\ndefault_mode_request_user_input = true\nother_feature = false\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('multi_agent'), 'removes multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'removes request_user_input');
    assert.ok(result.includes('other_feature = false'), 'preserves user features');
  });

  test('removes empty [features] section', () => {
    const content = `[features]\nmulti_agent = true\n[model]\nname = "o3"\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('[features]'), 'removes empty features section');
    assert.ok(result.includes('[model]'), 'preserves other sections');
  });

  test('strips injected keys above marker on uninstall', () => {
    // Case 3 install injects keys into [features] AND appends marker block
    const content = `[model]\nname = "o3"\n\n[features]\nmulti_agent = true\ndefault_mode_request_user_input = true\nsome_custom_flag = true\n\n${GSD_CODEX_MARKER}\n[agents]\nmax_threads = 4\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(result.includes('[model]'), 'preserves user model section');
    assert.ok(result.includes('some_custom_flag = true'), 'preserves user feature');
    assert.ok(!result.includes('multi_agent'), 'strips injected multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'strips injected request_user_input');
    assert.ok(!result.includes(GSD_CODEX_MARKER), 'strips marker');
  });

  test('removes [agents.gsd-*] sections', () => {
    const content = `[agents.gsd-executor]\ndescription = "test"\nconfig_file = "agents/gsd-executor.toml"\n\n[agents.custom-agent]\ndescription = "user agent"\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('[agents.gsd-executor]'), 'removes GSD agent section');
    assert.ok(result.includes('[agents.custom-agent]'), 'preserves user agent section');
  });
});

// ─── mergeCodexConfig ───────────────────────────────────────────────────────────

describe('mergeCodexConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-merge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleBlock = generateCodexConfigBlock([
    { name: 'gsd-executor', description: 'Executes plans' },
  ]);

  test('case 1: creates new config.toml', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    mergeCodexConfig(configPath, sampleBlock);

    assert.ok(fs.existsSync(configPath), 'file created');
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'has marker');
    assert.ok(content.includes('[agents.gsd-executor]'), 'has agent');
    assert.ok(!content.includes('[features]'), 'no features section');
    assert.ok(!content.includes('multi_agent'), 'no multi_agent');
  });

  test('case 2: replaces existing GSD block', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const userContent = '[model]\nname = "o3"\n';
    fs.writeFileSync(configPath, userContent + '\n' + sampleBlock + '\n');

    // Re-merge with updated block
    const newBlock = generateCodexConfigBlock([
      { name: 'gsd-executor', description: 'Updated description' },
      { name: 'gsd-planner', description: 'New agent' },
    ]);
    mergeCodexConfig(configPath, newBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]'), 'preserves user content');
    assert.ok(content.includes('Updated description'), 'has new description');
    assert.ok(content.includes('[agents.gsd-planner]'), 'has new agent');
    // Verify no duplicate markers
    const markerCount = (content.match(new RegExp(GSD_CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker');
  });

  test('case 3: appends to config without GSD marker', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[model]\nname = "o3"\n');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]'), 'preserves user content');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'adds marker');
    assert.ok(content.includes('[agents.gsd-executor]'), 'has agent');
  });

  test('case 3 with existing [features]: preserves user features, does not inject GSD keys', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n\n[model]\nname = "o3"\n');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('other_feature = true'), 'preserves existing feature');
    assert.ok(!content.includes('multi_agent'), 'does not inject multi_agent');
    assert.ok(!content.includes('default_mode_request_user_input'), 'does not inject request_user_input');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'adds marker for agents block');
    assert.ok(content.includes('[agents.gsd-executor]'), 'has agent');
  });

  test('case 3 strips existing [agents.gsd-*] sections before appending fresh block', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const existing = [
      '[model]',
      'name = "o3"',
      '',
      '[agents.custom-agent]',
      'description = "user agent"',
      '',
      '',
      '[agents.gsd-executor]',
      'description = "old"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, existing);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const gsdAgentCount = (content.match(/^\[agents\.gsd-executor\]\s*$/gm) || []).length;
    const markerCount = (content.match(new RegExp(GSD_CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

    assert.ok(content.includes('[model]'), 'preserves user content');
    assert.ok(content.includes('[agents.custom-agent]'), 'preserves non-GSD agent section');
    assert.strictEqual(gsdAgentCount, 1, 'keeps exactly one GSD agent section');
    assert.strictEqual(markerCount, 1, 'adds exactly one marker block');
    assert.ok(!/\n{3,}# GSD Agent Configuration/.test(content), 'does not leave extra blank lines before marker block');
  });

  test('idempotent: re-merge produces same result', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    mergeCodexConfig(configPath, sampleBlock);
    const first = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const second = fs.readFileSync(configPath, 'utf8');

    assert.strictEqual(first, second, 'idempotent merge');
  });

  test('case 2 after case 3 with existing [features]: no duplicate sections', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n\n[model]\nname = "o3"\n');
    mergeCodexConfig(configPath, sampleBlock);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const featuresCount = (content.match(/^\[features\]\s*$/gm) || []).length;
    assert.strictEqual(featuresCount, 1, 'exactly one [features] section');
    assert.ok(content.includes('other_feature = true'), 'preserves user feature keys');
    assert.ok(content.includes('[agents.gsd-executor]'), 'has agent');
    // Verify no duplicate markers
    const markerCount = (content.match(new RegExp(GSD_CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker');
  });

  test('case 2 does not inject feature keys', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const manualContent = '[features]\nother_feature = true\n\n' + GSD_CODEX_MARKER + '\n[agents.gsd-old]\ndescription = "old"\n';
    fs.writeFileSync(configPath, manualContent);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(!content.includes('multi_agent'), 'does not inject multi_agent');
    assert.ok(!content.includes('default_mode_request_user_input'), 'does not inject request_user_input');
    assert.ok(content.includes('other_feature = true'), 'preserves user feature');
    assert.ok(content.includes('[agents.gsd-executor]'), 'has agent from fresh block');
  });

  test('case 2 strips leaked [agents] and [agents.gsd-*] from before content', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'max_threads = 4',
      'max_depth = 2',
      '',
      '[agents.gsd-executor]',
      'description = "old"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, brokenContent);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('child_agents_md = false'), 'preserves user feature keys');
    assert.ok(content.includes('[agents.gsd-executor]'), 'has agent from fresh block');
    // Verify the leaked [agents] table header above marker was stripped
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.substring(0, markerIndex);
    assert.ok(!beforeMarker.match(/^\[agents\]\s*$/m), 'no leaked [agents] above marker');
    assert.ok(!beforeMarker.includes('[agents.gsd-'), 'no leaked [agents.gsd-*] above marker');
  });

  test('case 2 strips leaked GSD-managed sections above marker in CRLF files', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'max_threads = 4',
      '',
      '[agents.gsd-executor]',
      'description = "stale"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\r\n');
    fs.writeFileSync(configPath, brokenContent, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.slice(0, markerIndex);

    assert.ok(content.includes('child_agents_md = false'), 'preserves user feature keys');
    assert.strictEqual(countMatches(beforeMarker, /^\[agents\]\s*$/gm), 0, 'removes leaked [agents] above marker');
    assert.strictEqual(countMatches(beforeMarker, /^\[agents\.gsd-executor\]\s*$/gm), 0, 'removes leaked GSD agent section above marker');
    assert.strictEqual(countMatches(content, /^\[agents\.gsd-executor\]\s*$/gm), 1, 'keeps one managed agent section');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('case 2 preserves user-authored [agents] tables while stripping leaked GSD sections in CRLF files', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'default = "custom-agent"',
      '',
      '[agents.gsd-executor]',
      'description = "stale"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\r\n');
    fs.writeFileSync(configPath, brokenContent, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.slice(0, markerIndex);

    assert.ok(beforeMarker.includes('[agents]\r\ndefault = "custom-agent"\r\n'), 'preserves user-authored [agents] table');
    assert.strictEqual(countMatches(beforeMarker, /^\[agents\.gsd-executor\]\s*$/gm), 0, 'removes leaked GSD agent section above marker');
    assert.strictEqual(countMatches(content, /^\[agents\.gsd-executor\]\s*$/gm), 1, 'keeps one managed agent section in the GSD block');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('case 2 idempotent after case 3 with existing [features]', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n');
    mergeCodexConfig(configPath, sampleBlock);
    const first = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const second = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const third = fs.readFileSync(configPath, 'utf8');

    assert.strictEqual(first, second, 'idempotent after 2nd merge');
    assert.strictEqual(second, third, 'idempotent after 3rd merge');
  });

  test('preserves CRLF when appending GSD block to existing config', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[model]\r\nname = "o3"\r\n', 'utf8');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]\r\nname = "o3"\r\n'), 'preserves existing CRLF content');
    assert.ok(content.includes(`${GSD_CODEX_MARKER}\r\n`), 'writes marker with CRLF');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('uses the first newline style when appending GSD block to mixed-EOL configs', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '# first line wins\n[model]\r\nname = "o3"\r\n', 'utf8');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('# first line wins\n[model]\r\nname = "o3"'), 'preserves the existing mixed-EOL model content');
    assert.ok(content.includes(`\n\n${GSD_CODEX_MARKER}\n`), 'writes the managed block using the first newline style');
  });
});

// ─── Integration: installCodexConfig ────────────────────────────────────────────

describe('installCodexConfig (integration)', () => {
  let tmpTarget;
  const agentsSrc = path.join(__dirname, '..', 'agents');

  beforeEach(() => {
    tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-install-'));
  });

  afterEach(() => {
    fs.rmSync(tmpTarget, { recursive: true, force: true });
  });

  // Only run if agents/ directory exists (not in CI without full checkout)
  const hasAgents = fs.existsSync(agentsSrc);

  (hasAgents ? test : test.skip)('generates config.toml and agent .toml files', () => {
    const { installCodexConfig } = require('../bin/install.js');
    const count = installCodexConfig(tmpTarget, agentsSrc);

    assert.ok(count >= 11, `installed ${count} agents (expected >= 11)`);

    // Verify config.toml
    const configPath = path.join(tmpTarget, 'config.toml');
    assert.ok(fs.existsSync(configPath), 'config.toml exists');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.ok(config.includes(GSD_CODEX_MARKER), 'has GSD marker');
    assert.ok(config.includes('[agents.gsd-executor]'), 'has executor agent');
    assert.ok(!config.includes('multi_agent'), 'no feature flags');

    // Verify per-agent .toml files
    const agentsDir = path.join(tmpTarget, 'agents');
    assert.ok(fs.existsSync(path.join(agentsDir, 'gsd-executor.toml')), 'executor .toml exists');
    assert.ok(fs.existsSync(path.join(agentsDir, 'gsd-plan-checker.toml')), 'plan-checker .toml exists');

    const executorToml = fs.readFileSync(path.join(agentsDir, 'gsd-executor.toml'), 'utf8');
    assert.ok(executorToml.includes('name = "gsd-executor"'), 'executor has name');
    assert.ok(executorToml.includes('description = "Executes GSD plans with atomic commits, deviation handling, checkpoint protocols, and state management. Spawned by execute-phase orchestrator or execute-plan command."'), 'executor has description');
    assert.ok(executorToml.includes('sandbox_mode = "workspace-write"'), 'executor is workspace-write');
    assert.ok(executorToml.includes('developer_instructions'), 'has developer_instructions');

    const checkerToml = fs.readFileSync(path.join(agentsDir, 'gsd-plan-checker.toml'), 'utf8');
    assert.ok(checkerToml.includes('name = "gsd-plan-checker"'), 'plan-checker has name');
    assert.ok(checkerToml.includes('sandbox_mode = "read-only"'), 'plan-checker is read-only');
  });

  // PATHS-01: no ~/.claude references should leak into generated .toml files (#2320)
  // Covers both trailing-slash and bare end-of-string forms, and scans all .toml
  // files (agents/ subdirectory + top-level config.toml if present).
  (hasAgents ? test : test.skip)('generated .toml files contain no leaked ~/.claude paths (PATHS-01)', () => {
    const { installCodexConfig } = require('../bin/install.js');
    installCodexConfig(tmpTarget, agentsSrc);

    // Collect all .toml files: per-agent files in agents/ plus top-level config.toml
    const agentsDir = path.join(tmpTarget, 'agents');
    const tomlFiles = fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.toml'))
      .map(f => path.join(agentsDir, f));
    const topLevel = path.join(tmpTarget, 'config.toml');
    if (fs.existsSync(topLevel)) tomlFiles.push(topLevel);
    assert.ok(tomlFiles.length > 0, 'at least one .toml file generated');

    // Match ~/.claude, $HOME/.claude, or ./.claude with or without trailing slash
    const leakPattern = /(?:~|\$HOME|\.)\/\.claude(?:\/|$)/;
    const leaks = [];
    for (const filePath of tomlFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (leakPattern.test(content)) {
        leaks.push(path.relative(tmpTarget, filePath));
      }
    }
    assert.deepStrictEqual(leaks, [], `No .toml files should contain .claude paths; found leaks in: ${leaks.join(', ')}`);
  });
});

// ─── Codex config.toml [features] safety (#1202) ─────────────────────────────

describe('codex features section safety', () => {
  test('non-boolean keys under [features] are moved to top level', () => {
    // Simulate the bug from #1202: model = "gpt-5.4" under [features]
    // causes "invalid type: string, expected a boolean in features"
    const configContent = `[features]\ncodex_hooks = true\n\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[agents.gsd-executor]\ndescription = "test"\n`;

    const featuresMatch = configContent.match(/\[features\]\n([\s\S]*?)(?=\n\[|$)/);
    assert.ok(featuresMatch, 'features section found');

    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split('\n')
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/))
      .map(line => line.trim());

    assert.strictEqual(nonBooleanKeys.length, 2, 'should detect 2 non-boolean keys');
    assert.ok(nonBooleanKeys.includes('model = "gpt-5.4"'), 'detects model key');
    assert.ok(nonBooleanKeys.includes('model_reasoning_effort = "medium"'), 'detects model_reasoning_effort key');
  });

  test('boolean keys under [features] are NOT flagged', () => {
    const configContent = `[features]\ncodex_hooks = true\nmulti_agent = false\n`;

    const featuresMatch = configContent.match(/\[features\]\n([\s\S]*?)(?=\n\[|$)/);
    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split('\n')
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/))
      .map(line => line.trim());

    assert.strictEqual(nonBooleanKeys.length, 0, 'no non-boolean keys in a clean config');
  });
});

describe('Codex install hook configuration (e2e)', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-e2e-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Codex install copies hook file without wiring it into config.toml (#2153)', () => {
    // Regression test: Codex install still copies the hook file to $CODEX_HOME/hooks/
    // but hardened installs no longer wire the update hook into config.toml.
    runCodexInstall(codexHome);

    const configContent = readCodexConfig(codexHome);
    assert.ok(!configContent.includes('gsd-check-update.js'), 'config.toml does not reference gsd-check-update.js');
    assert.ok(!configContent.includes('event = "SessionStart"'), 'config.toml does not register a SessionStart hook');
    assert.ok(!configContent.includes('codex_hooks = true'), 'config.toml does not enable codex_hooks by default');
    // The hook file must physically exist at the referenced path
    const hookFile = path.join(codexHome, 'hooks', 'gsd-check-update.js');
    assert.ok(
      fs.existsSync(hookFile),
      `gsd-check-update.js must exist at ${hookFile} even though config.toml no longer references it`
    );
  });

  test('fresh CODEX_HOME does not inject Codex hook wiring or draft root defaults', () => {
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(!content.includes('codex_hooks = true'), 'does not enable codex_hooks by default');
    assert.ok(!content.includes('# GSD Hooks'), 'does not write a GSD hook block');
    assert.ok(!content.includes('event = "SessionStart"'), 'does not write a SessionStart hook');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not reference the update hook');
    assertNoDraftRootKeys(content);
    assertUsesOnlyEol(content, '\n');
  });

  test('config_file paths are absolute using CODEX_HOME', () => {
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    const agentsDir = path.join(codexHome, 'agents').replace(/\\/g, '/');
    // All config_file values should use absolute paths
    const configFileLines = content.split('\n').filter(l => l.startsWith('config_file = '));
    assert.ok(configFileLines.length > 0, 'has config_file entries');
    for (const line of configFileLines) {
      assert.ok(line.includes(agentsDir), `absolute path in: ${line}`);
    }
    assert.ok(!content.includes('config_file = "agents/'), 'no relative config_file paths');
  });

  test('re-install repairs non-boolean keys trapped under [features] by previous install (#1379)', () => {
    // Hardened Codex installs preserve legacy malformed [features] blocks as-is.
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      '',
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "high"',
      '',
      '[projects."/Users/oltmannk/myproject"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);

    // The legacy block stays where it was written.
    const featuresIndex = content.indexOf('[features]');
    const modelIndex = content.indexOf('model = "gpt-5.3-codex"');
    const reasoningIndex = content.indexOf('model_reasoning_effort = "high"');
    assert.ok(modelIndex !== -1, 'model key is present');
    assert.ok(reasoningIndex !== -1, 'model_reasoning_effort key is present');
    assert.ok(featuresIndex !== -1, '[features] section is present');
    assert.ok(featuresIndex < modelIndex, 'model key remains under [features]');
    assert.ok(featuresIndex < reasoningIndex, 'model_reasoning_effort remains under [features]');

    // Legacy malformed keys remain in place; install should not normalize them.
    const featuresMatch = content.match(/\[features\]\n([\s\S]*?)(?=\n\[|$)/);
    if (featuresMatch) {
      const featuresBody = featuresMatch[1];
      const nonBooleanKeys = featuresBody.split('\n')
        .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/));
      assert.strictEqual(nonBooleanKeys.length, 2, 'preserves the malformed model keys under [features]');
    }

    // User content preserved
    assert.ok(content.includes('[projects."/Users/oltmannk/myproject"]'), 'preserves project section');
    assert.ok(content.includes('trust_level = "trusted"'), 'preserves project trust level');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'preserves the user-authored codex_hooks value');
    assert.ok(!content.includes('# GSD Hooks'), 'does not write a GSD hook block');
    assert.ok(!content.includes('event = "SessionStart"'), 'does not register a SessionStart hook');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not reference the update hook');
  });

  test('existing LF config without [features] preserves user content without injecting Codex hooks', () => {
    writeCodexConfig(codexHome, [
      '# user comment',
      '[model]',
      'name = "o3"',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "echo custom"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('# user comment'), 'preserves user comment');
    assert.ok(content.includes('[model]\nname = "o3"'), 'preserves model section');
    assert.ok(content.includes('command = "echo custom"'), 'preserves custom hook');
    assert.ok(!content.includes('codex_hooks = true'), 'does not inject codex_hooks');
    assert.ok(!content.includes('# GSD Hooks'), 'does not inject a GSD hook block');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not reference the update hook');
    assertNoDraftRootKeys(content);
  });

  test('bare top-level keys are NOT trapped under [features] (#1202)', () => {
    // Real-world config: model= and model_reasoning_effort= at root level,
    // followed by [projects] section. GSD must not prepend [features] before
    // these keys, which would make Codex reject them as "expected a boolean".
    writeCodexConfig(codexHome, [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      '',
      '[projects."/home/user/myproject"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);

    const modelIndex = content.indexOf('model = "gpt-5.4"');
    const reasoningIndex = content.indexOf('model_reasoning_effort = "high"');
    assert.ok(modelIndex !== -1, 'model= stays at root');
    assert.ok(reasoningIndex !== -1, 'model_reasoning_effort= stays at root');
    assert.ok(!content.includes('[features]'), 'does not inject a [features] section');
    // User content preserved
    assert.ok(content.includes('[projects."/home/user/myproject"]'), 'preserves project section');
    assert.ok(content.includes('trust_level = "trusted"'), 'preserves project trust level');
  });

  test('existing CRLF config without [features] preserves CRLF without injecting Codex hooks', () => {
    writeCodexConfig(codexHome, '# user comment\r\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('# user comment'), 'preserves user comment');
    assert.ok(content.includes('[model]\r\nname = "o3"'), 'preserves model section');
    assert.ok(!content.includes('codex_hooks = true'), 'does not inject codex_hooks');
    assert.ok(!content.includes('# GSD Hooks'), 'does not inject a GSD hook block');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not reference the update hook');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('existing CRLF [features] comment-only table gets codex_hooks without losing adjacent text', () => {
    writeCodexConfig(codexHome, [
      '# user comment',
      '[features]',
      '# keep me',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not add codex_hooks');
    assert.ok(content.includes('[features]\r\n# keep me'), 'preserves the comment-only [features] table');
    assert.ok(content.includes('[model]\r\nname = "o3"\r\n'), 'preserves following table');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('existing [features] with trailing comment gets one codex_hooks without a second table', () => {
    writeCodexConfig(codexHome, [
      '[features] # keep comment',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\s*\[features\](?:\s*#.*)?$/gm), 1, 'keeps one commented [features] header');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not add codex_hooks');
    assert.ok(content.includes('[features] # keep comment\nother_feature = true'), 'preserves commented features table');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not inject the GSD update hook');
    assertNoDraftRootKeys(content);
  });

  test('existing [features] at EOF without trailing newline is updated in place', () => {
    writeCodexConfig(codexHome, '[model]\nname = "o3"\n\n[features]');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not add codex_hooks');
    assert.ok(content.includes('[features]'), 'preserves the existing [features] header');
    assertNoDraftRootKeys(content);
  });

  test('existing empty [features] and codex_hooks = false are normalized and remain idempotent', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = false',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "echo custom"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not rewrite codex_hooks');
    assert.ok(content.includes('codex_hooks = false'), 'preserves the existing codex_hooks value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assert.ok(content.includes('command = "echo custom"'), 'preserves custom hook');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not inject the GSD update hook');
    assertNoDraftRootKeys(content);
  });

  test('quoted codex_hooks keys inside [features] are normalized without adding a bare duplicate', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '"codex_hooks" = false',
      'other_feature = true',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^"codex_hooks" = true$/gm), 0, 'does not rewrite the quoted key');
    assert.ok(content.includes('"codex_hooks" = false'), 'preserves the quoted key value');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not append a bare duplicate codex_hooks key');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('quoted [features] headers are recognized as the existing features table', () => {
    writeCodexConfig(codexHome, [
      '["features"]',
      '"codex_hooks" = false',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[(?:"features"|'features'|features)\]\s*$/gm), 1, 'keeps one features table');
    assert.strictEqual(countMatches(content, /^"codex_hooks" = true$/gm), 0, 'does not rewrite the quoted codex_hooks key');
    assert.ok(content.includes('"codex_hooks" = false'), 'preserves the quoted codex_hooks value');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a second bare features table');
    assert.ok(content.includes('other_feature = true'), 'preserves existing feature keys');
    assertNoDraftRootKeys(content);
  });

  test('quoted table headers containing # are parsed without treating # as a comment start', () => {
    writeCodexConfig(codexHome, [
      '[features."a#b"]',
      'enabled = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('[features."a#b"]\nenabled = true'), 'preserves the quoted nested features table');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not add a real top-level features table');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not add codex_hooks');
    assertNoDraftRootKeys(content);
  });

  test('existing dotted features config stays dotted and does not grow a [features] table', () => {
    writeCodexConfig(codexHome, [
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not add a [features] table');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not add a dotted codex_hooks key');
    assert.ok(content.includes('features.other_feature = true'), 'preserves existing dotted features key');
    assertNoDraftRootKeys(content);
  });

  test('root inline-table features assignments are left untouched without appending invalid dotted keys or hooks', () => {
    writeCodexConfig(codexHome, [
      'features = { other_feature = true }',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features = { other_feature = true }'), 'preserves the root inline-table assignment');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append an invalid dotted codex_hooks key');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a features table');
    assert.strictEqual(countMatches(content, /gsd-check-update\.js/g), 0, 'does not add the GSD hook block when codex_hooks cannot be enabled safely');
    assert.ok(content.includes('[agents.gsd-executor]'), 'still installs the managed agent block');
    assertNoDraftRootKeys(content);
  });

  test('root scalar features assignments are left untouched without appending invalid dotted keys or hooks', () => {
    writeCodexConfig(codexHome, [
      'features = "disabled"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features = "disabled"'), 'preserves the root scalar assignment');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append an invalid dotted codex_hooks key');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a features table');
    assert.strictEqual(countMatches(content, /gsd-check-update\.js/g), 0, 'does not add the GSD hook block when codex_hooks cannot be enabled safely');
    assert.ok(content.includes('[agents.gsd-executor]'), 'still installs the managed agent block');
    assertNoDraftRootKeys(content);
  });

  test('quoted dotted codex_hooks keys stay dotted and are normalized without duplication', () => {
    writeCodexConfig(codexHome, [
      'features."codex_hooks" = false',
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not add a [features] table');
    assert.strictEqual(countMatches(content, /^features\."codex_hooks" = true$/gm), 0, 'does not rewrite the quoted dotted key');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append a bare dotted duplicate');
    assert.ok(content.includes('features."codex_hooks" = false'), 'preserves the quoted dotted key value');
    assert.ok(content.includes('features.other_feature = true'), 'preserves other dotted features keys');
    assertNoDraftRootKeys(content);
  });

  test('multiline dotted features assignments insert codex_hooks after the full assignment block', () => {
    writeCodexConfig(codexHome, [
      'features.notes = """',
      'keep-me',
      '"""',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features.notes = """\nkeep-me\n"""'), 'preserves the multiline dotted assignment');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not add a dotted codex_hooks key');
    assertNoDraftRootKeys(content);
  });

  test('existing empty [features] table is populated with one codex_hooks key', () => {
    writeCodexConfig(codexHome, '[features]\r\n\r\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not add codex_hooks');
    assert.ok(content.includes('[features]\r\n\r\n'), 'preserves the empty [features] table');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('multiline strings inside [features] do not create fake tables or fake codex_hooks matches', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'notes = \'\'\'',
      '[model]',
      'codex_hooks = false',
      '\'\'\'',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not add codex_hooks');
    assert.ok(content.includes('notes = \'\'\'\n[model]\ncodex_hooks = false\n\'\'\''), 'preserves multiline string content');
    assert.strictEqual(countMatches(content, /^codex_hooks = false$/gm), 1, 'does not rewrite codex_hooks text inside multiline string');
    assert.ok(content.indexOf('other_feature = true') > content.indexOf('notes = \'\'\''), 'preserves the multiline string content inside the [features] table');
    assertNoDraftRootKeys(content);
  });

  test('non-boolean codex_hooks assignments are normalized to true without duplication', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = "sometimes"',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not rewrite codex_hooks');
    assert.ok(content.includes('codex_hooks = "sometimes"'), 'preserves the original non-boolean value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('multiline basic-string codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = """',
      'multiline-basic-sentinel',
      'still-in-string',
      '"""',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not rewrite codex_hooks');
    assert.ok(content.includes('codex_hooks = """'), 'preserves the multiline basic-string assignment');
    assert.ok(content.includes('multiline-basic-sentinel'), 'preserves multiline basic-string continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    assertNoDraftRootKeys(content);
  });

  test('multiline literal-string codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = \'\'\'',
      'multiline-literal-sentinel',
      'still-in-literal',
      '\'\'\'',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not rewrite codex_hooks');
    assert.ok(content.includes('codex_hooks = \'\'\''), 'preserves the multiline literal-string assignment');
    assert.ok(content.includes('multiline-literal-sentinel'), 'preserves multiline literal-string continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    assertNoDraftRootKeys(content);
  });

  test('multiline array codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = [',
      '  "array-sentinel-1",',
      '  "array-sentinel-2",',
      ']',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not rewrite codex_hooks');
    assert.ok(content.includes('codex_hooks = ['), 'preserves the multiline array assignment');
    assert.ok(content.includes('array-sentinel-1'), 'preserves multiline array continuation lines');
    assert.ok(content.includes('array-sentinel-2'), 'preserves multiline array continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    assertNoDraftRootKeys(content);
  });

  test('triple-quoted codex_hooks values keep inline comments when normalized', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = """sometimes""" # keep me',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true # keep me$/gm), 0, 'does not rewrite codex_hooks');
    assert.ok(content.includes('codex_hooks = """sometimes""" # keep me'), 'preserves the triple-quoted value and comment');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('existing CRLF codex_hooks = true stays single and preserves non-GSD hooks', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'keeps one codex_hooks = true');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assert.strictEqual(countMatches(content, /echo custom-after-command/g), 1, 'preserves non-GSD hook exactly once');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not inject the GSD update hook');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('codex_hooks = true with an inline comment is treated as enabled for hook installation', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true # keep me',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true # keep me$/gm), 1, 'preserves the commented true value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not inject the GSD update hook');
    assertNoDraftRootKeys(content);
  });

  test('mixed-EOL configs use the first newline style for inserted Codex content', () => {
    writeCodexConfig(codexHome, '# first line wins\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes(`# GSD Agent Configuration — managed by get-shit-done installer\n`), 'writes the managed agent block using the first newline style');
    assert.ok(!content.includes('codex_hooks = true'), 'does not inject codex_hooks');
    assert.ok(!content.includes('# GSD Hooks'), 'does not write the GSD hook block');
    assert.ok(!content.includes('event = "SessionStart"'), 'does not register a SessionStart hook');
    assert.ok(!content.includes('gsd-check-update.js'), 'does not reference the update hook');
    assert.ok(content.includes('[model]\r\nname = "o3"'), 'preserves the existing CRLF model lines');
    assertNoDraftRootKeys(content);
  });
});

describe('Codex uninstall symmetry for hook-enabled configs', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-uninstall-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('fresh install removes the GSD-added codex_hooks feature on uninstall', () => {
    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.strictEqual(cleaned, null, 'fresh GSD-only config strips back to nothing');
  });

  test('install then uninstall removes [features].codex_hooks while preserving other feature keys, comments, hooks, and CRLF', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '# keep me',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned, 'preserves user config after uninstall cleanup');
    assert.strictEqual(countMatches(cleaned, /^\[features\](?:\s*#.*)?$/gm), 1, 'keeps the existing features table');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 0, 'removes the GSD-added codex_hooks key');
    assert.ok(cleaned.includes('# keep me'), 'preserves user comments in [features]');
    assert.ok(cleaned.includes('other_feature = true'), 'preserves other feature keys');
    assert.strictEqual(countMatches(cleaned, /echo custom-after-command/g), 1, 'preserves non-GSD hooks');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes only the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
    assertUsesOnlyEol(cleaned, '\r\n');
  });

  test('install then uninstall removes dotted features.codex_hooks without creating a [features] table', () => {
    writeCodexConfig(codexHome, [
      'features.other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('features.other_feature = true'), 'preserves other dotted feature keys');
    assert.strictEqual(countMatches(cleaned, /^features\.codex_hooks = true$/gm), 0, 'removes the dotted GSD codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /^\[features\]\s*$/gm), 0, 'does not leave behind a [features] table');
    assert.strictEqual(countMatches(cleaned, /echo custom-after-command/g), 1, 'preserves non-GSD hooks');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
  });

  test('install then uninstall preserves a pre-existing [features].codex_hooks = true', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('[features]\ncodex_hooks = true\nother_feature = true'), 'preserves the user-authored codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 1, 'keeps the pre-existing codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall preserves a pre-existing quoted [features].\"codex_hooks\" = true', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '"codex_hooks" = true',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('[features]\n"codex_hooks" = true\nother_feature = true'), 'preserves the user-authored quoted codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^"codex_hooks" = true$/gm), 1, 'keeps the pre-existing quoted codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall preserves a pre-existing root dotted features.codex_hooks = true', () => {
    writeCodexConfig(codexHome, [
      'features.codex_hooks = true',
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('features.codex_hooks = true\nfeatures.other_feature = true'), 'preserves the user-authored dotted codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^features\.codex_hooks = true$/gm), 1, 'keeps the pre-existing dotted codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall leaves short-circuited root features assignments untouched', () => {
    const cases = [
      'features = { other_feature = true }\n\n[model]\nname = "o3"\n',
      'features = "disabled"\n\n[model]\nname = "o3"\n',
    ];

    for (const initialContent of cases) {
      writeCodexConfig(codexHome, initialContent);
      runCodexInstall(codexHome);

      const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
      assert.strictEqual(cleaned, initialContent, `preserves short-circuited root features assignment: ${initialContent.split('\n')[0]}`);

      fs.rmSync(codexHome, { recursive: true, force: true });
      fs.mkdirSync(codexHome, { recursive: true });
    }
  });

  test('install then uninstall keeps mixed-EOL user content stable while removing GSD hook state', () => {
    const initialContent = [
      '# first line wins',
      '[features]',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n').replace(/^# first line wins\r\n/, '# first line wins\n');

    writeCodexConfig(codexHome, initialContent);
    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('# first line wins\n[features]\r\nother_feature = true\r\n\r\n[model]\r\nname = "o3"'), 'preserves the original mixed-EOL user content');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 0, 'removes the injected codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });
});
