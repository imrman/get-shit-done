// allow-test-rule: workflow-yaml-security-posture-is-the-product
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = [
  'test.yml',
  'security-scan.yml',
  'install-smoke.yml',
];
const HARDENED_UPSTREAM_SYNC_WORKFLOW = 'hardened-upstream-sync.yml';
const ALL_WORKFLOW_NAMES = fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
  .filter((name) => /\.ya?ml$/.test(name));

function readWorkflow(name) {
  return fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
}

function externalActionUses(workflow) {
  return workflow.split('\n')
    .map((line) => line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1])
    .filter((ref) => ref && !ref.startsWith('./'));
}

function checkoutStepBlocks(workflow) {
  const lines = workflow.split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('uses: actions/checkout@')) continue;

    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start])) {
      start -= 1;
    }

    const indent = lines[start].match(/^(\s*)-/)?.[1] ?? '';
    let end = start + 1;
    while (
      end < lines.length &&
      !lines[end].startsWith(`${indent}- `) &&
      !/^\S/.test(lines[end])
    ) {
      end += 1;
    }

    blocks.push(lines.slice(start, end).join('\n'));
  }

  return blocks;
}

function namedStepBlock(workflow, stepName) {
  const lines = workflow.split('\n');
  const marker = `- name: ${stepName}`;
  const start = lines.findIndex((line) => line.includes(marker));
  assert.notEqual(start, -1, `Missing workflow step: ${stepName}`);

  const indent = lines[start].match(/^(\s*)-/)?.[1] ?? '';
  let end = start + 1;
  while (
    end < lines.length &&
    !lines[end].startsWith(`${indent}- `) &&
    !/^\S/.test(lines[end])
  ) {
    end += 1;
  }

  return lines.slice(start, end).join('\n');
}

function namedJobBlock(workflow, jobName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `Missing workflow job: ${jobName}`);

  let end = start + 1;
  while (end < lines.length && !/^  [A-Za-z0-9_-]+:/.test(lines[end])) {
    end += 1;
  }

  return lines.slice(start, end).join('\n');
}

describe('read-only workflow token hardening', () => {
  test('all external workflow actions are pinned to full commit SHAs', () => {
    for (const workflowName of ALL_WORKFLOW_NAMES) {
      for (const actionRef of externalActionUses(readWorkflow(workflowName))) {
        assert.match(
          actionRef,
          /^[^@]+@[0-9a-f]{40}$/,
          `${workflowName} must pin ${actionRef} to a full commit SHA`
        );
      }
    }
  });

  for (const workflowName of WORKFLOWS) {
    test(`${workflowName} declares read-only repository permissions`, () => {
      const workflow = readWorkflow(workflowName);
      const permissionsIndex = workflow.indexOf('permissions:\n  contents: read\n');
      const jobsIndex = workflow.indexOf('jobs:');

      assert.notEqual(permissionsIndex, -1, `${workflowName} must set permissions.contents to read`);
      assert.ok(permissionsIndex < jobsIndex, `${workflowName} permissions must apply at workflow scope`);
    });

    test(`${workflowName} disables checkout credential persistence`, () => {
      const workflow = readWorkflow(workflowName);
      const checkoutBlocks = checkoutStepBlocks(workflow);

      assert.ok(checkoutBlocks.length > 0, `${workflowName} should have at least one checkout step`);
      for (const block of checkoutBlocks) {
        assert.match(
          block,
          /\n\s+persist-credentials:\s*false(?:\n|$)/,
          `${workflowName} checkout step must set persist-credentials: false`
        );
      }
    });
  }
});

describe('hardened upstream sync credential boundary', () => {
  test('hardened-upstream-sync keeps write permission scoped to promotion and disables checkout credential persistence', () => {
    const workflow = readWorkflow(HARDENED_UPSTREAM_SYNC_WORKFLOW);
    const permissionsIndex = workflow.indexOf('permissions:\n  contents: read\n');
    const jobsIndex = workflow.indexOf('jobs:');
    const promoteJob = namedJobBlock(workflow, 'promote');
    const checkoutBlocks = checkoutStepBlocks(workflow);

    assert.notEqual(permissionsIndex, -1, 'hardened sync must default to read-only permissions');
    assert.ok(permissionsIndex < jobsIndex, 'hardened sync read permissions must apply at workflow scope');
    assert.match(promoteJob, /permissions:\n\s+contents: write\n/, 'promotion job must retain contents: write for scheduled/manual promotion');
    assert.ok(checkoutBlocks.length > 0, 'hardened sync should have a checkout step');
    for (const block of checkoutBlocks) {
      assert.match(
        block,
        /\n\s+persist-credentials:\s*false(?:\n|$)/,
        'hardened sync checkout step must set persist-credentials: false'
      );
    }
  });

  test('hardened-upstream-sync does not preinstall the GitHub extraheader before validation', () => {
    const workflow = readWorkflow(HARDENED_UPSTREAM_SYNC_WORKFLOW);

    assert.doesNotMatch(
      workflow,
      /git config --local http\.https:\/\/github\.com\/\.extraheader/,
      'workflow must not install the write token as a git extraheader before invoking validation'
    );
    assert.match(
      workflow,
      /GH_PUSH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
      'workflow should pass the token to the sync script for just-in-time push credential setup'
    );
    assert.match(
      workflow,
      /bash \.\/scripts\/unattended-upstream-sync\.sh[\s\S]*--require-push/,
      'workflow should still require a successful push after validation'
    );
  });

  test('hardened-upstream-sync separates candidate validation from token-bearing promotion', () => {
    const workflow = readWorkflow(HARDENED_UPSTREAM_SYNC_WORKFLOW);
    const validateJob = namedJobBlock(workflow, 'validate');
    const attestJob = namedJobBlock(workflow, 'attest');
    const promoteJob = namedJobBlock(workflow, 'promote');

    assert.match(workflow, /permissions:\n  contents: read\n/, 'workflow default token should be read-only');
    assert.match(validateJob, /permissions:\n\s+contents: read\n/, 'candidate validation job should be read-only');
    assert.match(validateJob, /--dry-run/, 'candidate validation job should validate without promoting');
    assert.doesNotMatch(validateJob, /GH_PUSH_TOKEN/, 'candidate validation job must not receive the push token');
    assert.doesNotMatch(validateJob, /--require-push/, 'candidate validation job must not push');

    assert.match(attestJob, /needs:\s*\[resolve, validate\]/, 'fresh attestation must wait for successful validation');
    assert.match(promoteJob, /needs:\s*\[validate, attest\]/, 'promotion must wait for validation eligibility and fresh trusted attestation');
    assert.match(promoteJob, /permissions:\n\s+contents: write\n/, 'promotion job may request write permission');
    assert.match(promoteJob, /GH_PUSH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, 'promotion job should receive the push token');
    assert.match(promoteJob, /--trusted-promote-only/, 'promotion job should use trusted no-validation promotion mode');
    assert.match(promoteJob, /--require-push/, 'promotion job should still require a successful push');
    assert.doesNotMatch(promoteJob, /--dry-run/, 'promotion job must not run validation-only mode');
    assert.doesNotMatch(promoteJob, /--allow-validation-rejection/, 'promotion job must not soft-pass validation failures');
  });

  test('hardened-upstream-sync uses a fresh trusted attestation job after candidate validation', () => {
    const workflow = readWorkflow(HARDENED_UPSTREAM_SYNC_WORKFLOW);
    const resolveJob = namedJobBlock(workflow, 'resolve');
    const validateJob = namedJobBlock(workflow, 'validate');
    const attestJob = namedJobBlock(workflow, 'attest');
    const promoteJob = namedJobBlock(workflow, 'promote');
    const attestationStep = namedStepBlock(workflow, 'Attest promotion candidate identities');

    assert.match(resolveJob, /permissions:\n\s+contents: read\n/, 'release resolution must be read-only');
    assert.match(
      resolveJob,
      /outputs:[\s\S]*upstream_ref:\s*\$\{\{\s*steps\.resolve-release\.outputs\.upstream_ref\s*\}\}/,
      'the trusted resolver must export the single stable release ref'
    );
    for (const identity of ['upstream_sha', 'origin_sha', 'candidate_tree_sha']) {
      assert.match(
        resolveJob,
        new RegExp(`${identity}:\\s*\\$\\{\\{\\s*steps\\.resolve-identities\\.outputs\\.${identity}\\s*\\}\\}`),
        `the trusted resolver must compute and export ${identity} before candidate validation`
      );
      assert.match(
        validateJob,
        new RegExp(`EXPECTED_${identity.toUpperCase()}:\\s*\\$\\{\\{\\s*needs\\.resolve\\.outputs\\.${identity}\\s*\\}\\}`),
        `validation must receive resolver-pinned ${identity}`
      );
      assert.match(
        attestJob,
        new RegExp(`EXPECTED_${identity.toUpperCase()}:\\s*\\$\\{\\{\\s*needs\\.resolve\\.outputs\\.${identity}\\s*\\}\\}`),
        `post-validation attestation must receive resolver-pinned ${identity}`
      );
    }
    const resolveIdentityStep = namedStepBlock(workflow, 'Resolve trusted candidate identities');
    assert.match(resolveIdentityStep, /--identity-attest-only/, 'resolver identities must be computed without candidate execution');
    assert.doesNotMatch(resolveIdentityStep, /GH_PUSH_TOKEN|github\.token/, 'resolver identity computation must not receive a token');
    for (const flag of ['upstream', 'origin', 'candidate-tree']) {
      const variable = `EXPECTED_${flag.replace('-', '_').toUpperCase()}_SHA`;
      assert.match(
        validateJob,
        new RegExp(`--expected-${flag}-sha "\\$${variable}"`),
        `validation must enforce resolver-pinned ${flag} identity`
      );
      assert.match(
        attestationStep,
        new RegExp(`--expected-${flag}-sha "\\$${variable}"`),
        `attestation must recompute and enforce resolver-pinned ${flag} identity`
      );
    }
    assert.match(validateJob, /needs:\s*resolve/, 'validation must use the trusted resolved release');
    assert.match(
      validateJob,
      /UPSTREAM_REF:\s*\$\{\{\s*needs\.resolve\.outputs\.upstream_ref\s*\}\}/,
      'validation must validate exactly the resolver-selected release'
    );
    assert.doesNotMatch(
      validateJob,
      /steps\.validate-candidate\.outputs\.(?:upstream_sha|origin_sha|candidate_tree_sha)/,
      'candidate validation must not export candidate-computed promotion identities'
    );
    assert.doesNotMatch(
      promoteJob,
      /needs\.validate\.outputs\.(?:upstream_sha|origin_sha|candidate_tree_sha)/,
      'promotion must not consume candidate-runner identity outputs'
    );
    assert.match(
      attestJob,
      /needs:\s*\[resolve, validate\]/,
      'fresh identity attestation must wait for resolution and candidate validation'
    );
    assert.match(
      attestJob,
      /UPSTREAM_REF:\s*\$\{\{\s*needs\.resolve\.outputs\.upstream_ref\s*\}\}/,
      'attestation must recompute the same release selected before validation'
    );
    assert.match(
      attestJob,
      /permissions:\n\s+contents: read\n/,
      'identity attestation must remain read-only'
    );
    assert.match(
      attestJob,
      /outputs:[\s\S]*upstream_sha:\s*\$\{\{\s*steps\.attest-identities\.outputs\.upstream_sha\s*\}\}[\s\S]*origin_sha:\s*\$\{\{\s*steps\.attest-identities\.outputs\.origin_sha\s*\}\}[\s\S]*candidate_tree_sha:\s*\$\{\{\s*steps\.attest-identities\.outputs\.candidate_tree_sha\s*\}\}/,
      'the fresh attestation job must recompute and export every promotion identity itself'
    );
    assert.match(
      attestJob,
      /upstream_ref:\s*\$\{\{\s*steps\.record-release\.outputs\.upstream_ref\s*\}\}/,
      'attestation must relay only the trusted resolver-selected ref alongside its recomputed identities'
    );
    assert.match(
      attestationStep,
      /--identity-attest-only/,
      'attestation must use the trusted no-candidate-execution identity mode'
    );
    assert.doesNotMatch(
      attestationStep,
      /GH_PUSH_TOKEN|github\.token/,
      'identity attestation must not receive a token'
    );
    assert.doesNotMatch(
      attestationStep,
      /--dry-run|--require-push|--trusted-promote-only/,
      'identity attestation must neither validate candidate code nor promote it'
    );
    assert.match(
      promoteJob,
      /needs:\s*\[validate, attest\]/,
      'promotion must wait for validation eligibility and the fresh trusted attestation job'
    );
  });

  test('hardened-upstream-sync promotion consumes only fresh attestation identities', () => {
    const workflow = readWorkflow(HARDENED_UPSTREAM_SYNC_WORKFLOW);
    const promoteJob = namedJobBlock(workflow, 'promote');

    assert.match(
      promoteJob,
      /UPSTREAM_REF:\s*\$\{\{\s*needs\.attest\.outputs\.upstream_ref\s*\}\}/,
      'promotion must source the stable release ref from fresh trusted attestation'
    );
    assert.doesNotMatch(
      promoteJob,
      /needs\.validate\.outputs\.(?:upstream_sha|origin_sha|candidate_tree_sha)/,
      'promotion must not consume candidate-runner identity outputs'
    );

    for (const identity of ['upstream_sha', 'origin_sha', 'candidate_tree_sha']) {
      assert.match(
        promoteJob,
        new RegExp(`EXPECTED_${identity.toUpperCase()}:\\s*\\$\\{\\{\\s*needs\\.attest\\.outputs\\.${identity}\\s*\\}\\}`),
        `promotion must source ${identity} from fresh trusted attestation`
      );
      assert.match(
        promoteJob,
        new RegExp(`if \\[ -z "\\$\\{EXPECTED_${identity.toUpperCase()}:-\\}" \\]; then[\\s\\S]*EXPECTED_${identity.toUpperCase()} is not set`),
        `promotion must fail closed when ${identity} is missing`
      );
    }
    assert.match(
      promoteJob,
      /--expected-upstream-sha "\$EXPECTED_UPSTREAM_SHA"/,
      'promotion must enforce the locally attested upstream SHA'
    );
    assert.match(
      promoteJob,
      /--expected-origin-sha "\$EXPECTED_ORIGIN_SHA"/,
      'promotion must enforce the locally attested origin/base SHA'
    );
    assert.match(
      promoteJob,
      /--expected-candidate-tree-sha "\$EXPECTED_CANDIDATE_TREE_SHA"/,
      'promotion must enforce the locally attested candidate tree content'
    );
  });
});

describe('security-scan trusted scanner ref hardening', () => {
  test('trusted scanner checkout uses a resolved ref instead of github.sha fallback', () => {
    const workflow = readWorkflow('security-scan.yml');
    const trustedCheckout = namedStepBlock(workflow, 'Checkout trusted scanner source');

    assert.doesNotMatch(
      trustedCheckout,
      /github\.sha/,
      'trusted scanner checkout must not trust the candidate commit as its fallback scanner ref'
    );
    assert.match(
      trustedCheckout,
      /repository:\s*\$\{\{\s*steps\.trusted-scanner-source\.outputs\.repository\s*\}\}/,
      'trusted scanner checkout should use the repository resolved by the trusted source gate'
    );
    assert.match(
      trustedCheckout,
      /ref:\s*\$\{\{\s*steps\.trusted-scanner-source\.outputs\.ref\s*\}\}/,
      'trusted scanner checkout should use the ref resolved by the trusted source gate'
    );
  });

  test('trusted scanner source gate preserves PR base SHA and push before SHA handling', () => {
    const workflow = readWorkflow('security-scan.yml');
    const resolver = namedStepBlock(workflow, 'Resolve trusted scanner source');

    assert.match(resolver, /PR_BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
    assert.match(resolver, /PR_BASE_REPOSITORY:\s*\$\{\{\s*github\.event\.pull_request\.base\.repo\.full_name\s*\}\}/);
    assert.match(resolver, /TRUSTED_SCANNER_REF="\$PR_BASE_SHA"/);
    assert.match(resolver, /TRUSTED_SCANNER_REPOSITORY="\$PR_BASE_REPOSITORY"/);
    assert.match(resolver, /PUSH_BEFORE_SHA:\s*\$\{\{\s*github\.event\.before\s*\}\}/);
    assert.match(resolver, /TRUSTED_SCANNER_REF="\$PUSH_BEFORE_SHA"/);
    assert.match(resolver, /ZERO_SHA='0000000000000000000000000000000000000000'/);
    assert.match(resolver, /\[ "\$PUSH_BEFORE_SHA" != "\$ZERO_SHA" \]/);
    assert.match(
      resolver,
      /Push runs require a non-zero before SHA/,
      'push first-commit or missing-before cases must fail closed instead of trusting github.sha'
    );
  });

  test('manual security scans require an explicit trusted scanner ref', () => {
    const workflow = readWorkflow('security-scan.yml');
    const resolver = namedStepBlock(workflow, 'Resolve trusted scanner source');

    assert.match(workflow, /trusted_scanner_ref:/, 'workflow_dispatch should expose a trusted scanner ref input');
    assert.match(
      resolver,
      /DISPATCH_TRUSTED_SCANNER_REF:\s*\$\{\{\s*inputs\.trusted_scanner_ref\s*\}\}/,
      'manual scans should read only the explicit trusted scanner ref input'
    );
    assert.doesNotMatch(
      resolver,
      /TRUSTED_SCANNER_REF="\$DISPATCH_TRUSTED_SCANNER_REF"/,
      'the untrusted manual input must not become the scanner checkout ref directly'
    );
    assert.match(
      resolver,
      /workflow_dispatch requires trusted_scanner_ref/,
      'manual scans must fail closed when no trusted scanner ref is supplied'
    );
    assert.doesNotMatch(resolver, /github\.sha/, 'manual trusted scanner source must not fall back to github.sha');
  });

  test('manual security scans require a full commit SHA for the trusted scanner ref', () => {
    const workflow = readWorkflow('security-scan.yml');
    const resolver = namedStepBlock(workflow, 'Resolve trusted scanner source');

    assert.match(
      workflow,
      /description:\s*'Current default-branch full 40-character commit SHA for scanner scripts'/,
      'manual scanner ref input should document that only the current default-branch SHA is accepted'
    );
    assert.match(
      resolver,
      /if ! is_commit_sha "\$DISPATCH_TRUSTED_SCANNER_REF"; then/,
      'manual scanner refs must reject branch, tag, and short SHA inputs before checkout'
    );
    assert.match(
      resolver,
      /workflow_dispatch trusted_scanner_ref must be a full 40-character commit SHA/,
      'manual scanner ref rejection should explain the full-SHA requirement'
    );
  });

  test('manual security scans reject stale ancestor scanner SHAs', () => {
    const workflow = readWorkflow('security-scan.yml');
    const resolver = namedStepBlock(workflow, 'Resolve trusted scanner source');

    assert.match(resolver, /DEFAULT_BRANCH:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
    assert.match(resolver, /trusted_git\(\)/, 'manual reachability checks must ignore injected Git configuration');
    assert.match(
      resolver,
      /trusted_git -C scan-target fetch[\s\S]*"https:\/\/github\.com\/\$\{DEFAULT_REPOSITORY\}\.git"[\s\S]*"refs\/heads\/\$\{DEFAULT_BRANCH\}"/,
      'manual scans must fetch an explicit trusted branch from the event repository'
    );
    assert.doesNotMatch(
      resolver,
      /merge-base --is-ancestor/,
      'ancestor reachability is insufficient because it permits stale scanner revisions'
    );
    assert.match(
      resolver,
      /\[ "\$DISPATCH_TRUSTED_SCANNER_REF" != "\$TRUSTED_REPOSITORY_REF" \]/,
      'manual scanner SHA must exactly equal the fetched default-branch tip'
    );
  });

  test('manual security scans accept and checkout the current fetched default-branch scanner SHA', () => {
    const workflow = readWorkflow('security-scan.yml');
    const resolver = namedStepBlock(workflow, 'Resolve trusted scanner source');

    assert.match(
      resolver,
      /TRUSTED_REPOSITORY_REF="\$\(trusted_git -C scan-target rev-parse FETCH_HEAD\)"[\s\S]*TRUSTED_SCANNER_REF="\$TRUSTED_REPOSITORY_REF"/,
      'the accepted manual scanner source must be the exact fetched default-branch commit'
    );
  });

  test('manual security scans reject candidate or foreign scanner SHAs', () => {
    const workflow = readWorkflow('security-scan.yml');
    const resolver = namedStepBlock(workflow, 'Resolve trusted scanner source');

    assert.match(
      resolver,
      /if \[ "\$DISPATCH_TRUSTED_SCANNER_REF" != "\$TRUSTED_REPOSITORY_REF" \]; then[\s\S]*workflow_dispatch trusted_scanner_ref must exactly match the current trusted repository default branch commit[\s\S]*exit 1/,
      'every nonmatching manual SHA must fail closed before trusted scanner checkout'
    );
  });
});

describe('install-smoke workflow hardening', () => {
  test('install smoke does not mask get-shit-done-cc installer failures', () => {
    const workflow = readWorkflow('install-smoke.yml');
    const installStep = namedStepBlock(workflow, 'Install tarball globally (runs bin/install.js → installSdkIfNeeded)');

    assert.doesNotMatch(
      installStep,
      /get-shit-done-cc --claude --local\s*\|\|\s*true/,
      'install-smoke must not blanket-ignore installer failures'
    );
    assert.match(
      installStep,
      /get-shit-done-cc --claude --local/,
      'install-smoke should still exercise the non-interactive installer path'
    );
  });

  test('install smoke uses npm pack output for tarball selection instead of ls-first matching', () => {
    const workflow = readWorkflow('install-smoke.yml');
    const packStep = namedStepBlock(workflow, 'Pack root tarball');

    assert.match(
      packStep,
      /npm pack --silent/,
      'install-smoke should still pack the root package before global install'
    );
    assert.match(
      packStep,
      /(?:PACK_OUTPUT|TARBALL)=.*tail -n 1/,
      'install-smoke must derive the tarball path from npm pack --silent output'
    );
    assert.doesNotMatch(
      packStep,
      /ls get-shit-done-cc-\*\.tgz \| head -1/,
      'install-smoke must not pick the first matching tarball from the workspace'
    );
  });

  test('install smoke rejects empty or path-like npm pack output', () => {
    const workflow = readWorkflow('install-smoke.yml');
    const packStep = namedStepBlock(workflow, 'Pack root tarball');

    assert.match(
      packStep,
      /if \[ -z "\$TARBALL" \]; then[\s\S]*npm pack did not report a tarball path[\s\S]*exit 1/,
      'install-smoke must fail closed when npm pack produces no tarball name'
    );
    assert.match(
      packStep,
      /case "\$TARBALL" in[\s\S]*''\|'\.'\|'\.\.'\|\*\/\*[\s\S]*npm pack returned an unsafe tarball path[\s\S]*exit 1/,
      'install-smoke must reject empty, dot, dot-dot, and path-like npm pack output'
    );
    assert.doesNotMatch(
      packStep,
      /echo "tarball=\$TARBALL" >> "\$GITHUB_OUTPUT"[\s\S]*case "\$TARBALL" in/,
      'install-smoke must validate npm pack output before exposing it to later steps'
    );
  });
});

describe('security-scan planning directory check hardening', () => {
  test('planning directory check uses NUL-delimited matching for unusual filenames', () => {
    const workflow = readWorkflow('security-scan.yml');
    const planningCheck = namedStepBlock(workflow, 'Planning directory check');

    assert.match(
      planningCheck,
      /git diff --name-only -z --diff-filter=ACMR/,
      'planning check must use NUL-delimited git diff output so quoted newline paths are not missed'
    );
    assert.match(
      planningCheck,
      /RS="\\0"/,
      'planning check must consume NUL-delimited paths with a NUL-aware matcher'
    );
    assert.match(
      planningCheck,
      /\^\\\.planning\\\//,
      'planning check must match paths beginning with .planning/ after NUL-safe parsing'
    );
    assert.doesNotMatch(
      planningCheck,
      /git diff --name-only[^\n|]*\|\s*grep ['"]\^\\\.planning\//,
      'planning check must not use line-oriented grep on quoted git diff output'
    );
  });

  test('planning directory check reports matched file count without echoing raw paths', () => {
    const workflow = readWorkflow('security-scan.yml');
    const planningCheck = namedStepBlock(workflow, 'Planning directory check');
    const tokenLikePath = [
      '.planning/TOKEN_',
      'gh',
      'p_',
      '0123456789abcdef0123456789abcdef0123',
      '.md',
    ].join('');

    assert.doesNotMatch(
      planningCheck,
      /echo "\$PLANNING_FILES"/,
      'planning check must not echo raw matched .planning/ paths into CI logs'
    );
    assert.doesNotMatch(
      planningCheck,
      new RegExp(tokenLikePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'regression fixture: token-like .planning/ filename must not be embedded in workflow output'
    );
    assert.match(
      planningCheck,
      /PLANNING_FILE_COUNT=/,
      'planning check should count matches instead of logging matched paths'
    );
    assert.match(
      planningCheck,
      /\.planning\/ runtime data files? were found/,
      'planning check should report a sanitized count-only message'
    );
  });
});
