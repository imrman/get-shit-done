// allow-test-rule: workflow-yaml-release-policy-is-the-product
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'hardened-upstream-sync.yml');

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

function namedStepBlock(job, stepName) {
  const lines = job.split('\n');
  const marker = `- name: ${stepName}`;
  const start = lines.findIndex((line) => line.includes(marker));
  assert.notEqual(start, -1, `Missing workflow step: ${stepName}`);

  const indent = lines[start].match(/^(\s*)-/)?.[1] ?? '';
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith(`${indent}- `)) {
    end += 1;
  }

  return lines.slice(start, end).join('\n');
}

describe('hardened upstream sync workflow release policy', () => {
  test('resolves latest official stable upstream release instead of tracking upstream main', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

    assert.ok(workflow.includes('Resolve latest stable upstream release'));
    assert.ok(workflow.includes('gh release list'));
    assert.ok(workflow.includes('--exclude-drafts'));
    assert.ok(workflow.includes('--exclude-pre-releases'));
    assert.ok(workflow.includes('--require-stable-upstream-ref'));
    assert.ok(workflow.includes('^v?[0-9]+[.][0-9]+[.][0-9]+$'));
    assert.equal(/UPSTREAM_REF:\s*main/.test(workflow), false);
  });

  test('keeps GitHub manual-only and forces manual candidate revalidation', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const validateJob = namedJobBlock(workflow, 'validate');

    assert.match(workflow, /on:\n\s+workflow_dispatch:/);
    assert.doesNotMatch(workflow, /\n\s+schedule:/, 'the persistent local automation is the only scheduled updater');
    assert.doesNotMatch(
      validateJob,
      /--allow-validation-rejection/,
      'manual dispatch must not suppress a previously blocked candidate'
    );
    assert.doesNotMatch(
      workflow,
      /actions\/cache\/(?:restore|save)@|gsd-upstream-sync-blocked-state/,
      'manual-only GitHub runs must not maintain a second blocked-candidate state store'
    );
  });

  test('classifies sync exit codes as explicit machine-readable validation outcomes', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const validateJob = namedJobBlock(workflow, 'validate');

    assert.match(validateJob, /outputs:[\s\S]*sync_outcome:\s*\$\{\{\s*steps\.validate-candidate\.outputs\.sync_outcome\s*\}\}/);
    assert.match(validateJob, /eligible_for_promotion:\s*\$\{\{\s*steps\.validate-candidate\.outputs\.eligible_for_promotion\s*\}\}/);
    assert.match(validateJob, /sync_exit=\$\?/, 'the workflow must capture the sync script exit directly');
    assert.doesNotMatch(validateJob, /\|\|\s*true|PIPESTATUS/, 'the trusted exit must not be masked or inferred from a pipeline');
    assert.match(validateJob, /"0:SYNC_OUTCOME=VALIDATED"\)[\s\S]*eligible_for_promotion="true"/);
    assert.match(validateJob, /"0:SYNC_OUTCOME=NO_CHANGE"\)[\s\S]*sync_outcome="NO_CHANGE"/);
    assert.match(validateJob, /"2:SYNC_OUTCOME=BLOCKED_VALIDATION"\)[\s\S]*sync_outcome="BLOCKED_VALIDATION"/);
    assert.match(validateJob, /"3:SYNC_OUTCOME=BLOCKED_VALIDATION_SUPPRESSED"\)[\s\S]*sync_outcome="BLOCKED_VALIDATION_SUPPRESSED"/);
    assert.match(validateJob, /\*\)[\s\S]*sync_outcome="BLOCKED_INFRA"/);
    assert.match(validateJob, /printf 'sync_outcome=%s\\n' "\$sync_outcome" >> "\$GITHUB_OUTPUT"/);
    assert.match(validateJob, /printf 'eligible_for_promotion=%s\\n' "\$eligible_for_promotion" >> "\$GITHUB_OUTPUT"/);
  });

  test('reports a trusted merge conflict without making it eligible for downstream release jobs', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const validateJob = namedJobBlock(workflow, 'validate');

    assert.match(
      validateJob,
      /"4:SYNC_OUTCOME=BLOCKED_CONFLICT"\)[\s\S]*sync_outcome="BLOCKED_CONFLICT"[\s\S]*;;/
    );
    assert.match(validateJob, /eligible_for_promotion="false"/, 'conflicts must retain the fail-closed default');
    assert.match(
      validateJob,
      /::error::Upstream synchronization is not eligible for promotion: \$\{SYNC_OUTCOME\}/,
      'the conflict outcome must be visible in the failed validation job'
    );

    for (const jobName of ['attest', 'promote']) {
      assert.match(
        namedJobBlock(workflow, jobName),
        /if:\s*needs\.validate\.outputs\.eligible_for_promotion == 'true'/,
        `${jobName} must stay closed for a conflict outcome`
      );
    }
    assert.match(namedJobBlock(workflow, 'package_secure_codex'), /needs:\s*promote/);
    assert.match(namedJobBlock(workflow, 'sign_secure_codex'), /needs:\s*\[promote, package_secure_codex\]/);
  });

  test('uses one trusted direct-child outcome file and validates that it contains exactly one line', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const validateJob = namedJobBlock(workflow, 'validate');

    assert.ok(validateJob.includes('outcome_file="$RUNNER_TEMP/gsd-sync-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.outcome"'));
    assert.match(validateJob, /--outcome-file "\$outcome_file"/);
    assert.match(validateJob, /mapfile -t outcome_lines < "\$outcome_file"/);
    assert.match(validateJob, /\[ "\$\{#outcome_lines\[@\]\}" -eq 1 \]/);
  });

  test('forged candidate stdout cannot influence trusted outcome classification', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const validateJob = namedJobBlock(workflow, 'validate');

    assert.doesNotMatch(validateJob, /workflow_log|workflow-output\.log|grep[^\n]*SYNC_OUTCOME/);
    assert.match(validateJob, /case "\$\{sync_exit\}:\$\{outcome_line\}" in/);
  });

  test('attestation and promotion require an explicit true validation eligibility output', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const validateJob = namedJobBlock(workflow, 'validate');
    const attestJob = namedJobBlock(workflow, 'attest');
    const promoteJob = namedJobBlock(workflow, 'promote');

    assert.match(validateJob, /"0:SYNC_OUTCOME=VALIDATED"\)[\s\S]*eligible_for_promotion="true"/);
    assert.match(validateJob, /eligible_for_promotion="false"/, 'eligibility must default closed');
    assert.match(validateJob, /if:\s*steps\.validate-candidate\.outputs\.eligible_for_promotion != 'true' && steps\.validate-candidate\.outputs\.sync_outcome != 'NO_CHANGE'/);
    assert.match(attestJob, /if:\s*needs\.validate\.outputs\.eligible_for_promotion == 'true'/);
    assert.match(promoteJob, /needs:\s*\[validate, attest\]/);
    assert.match(promoteJob, /if:\s*needs\.validate\.outputs\.eligible_for_promotion == 'true'/);
  });

  test('packages only after promotion and delegates private-repository signing to a later isolated job', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const promoteJob = namedJobBlock(workflow, 'promote');
    const packageJob = namedJobBlock(workflow, 'package_secure_codex');
    const signingJob = namedJobBlock(workflow, 'sign_secure_codex');

    assert.ok(workflow.indexOf(promoteJob) < workflow.indexOf(packageJob));
    assert.ok(workflow.indexOf(packageJob) < workflow.indexOf(signingJob));
    assert.match(packageJob, /needs:\s*promote/);
    assert.match(packageJob, /runs-on:\s*ubuntu-latest/);
    assert.match(signingJob, /needs:\s*\[promote, package_secure_codex\]/);
    assert.match(signingJob, /runs-on:\s*ubuntu-latest/);
  });

  test('exports the exact promoted identity and builds from a clean checkout of that SHA', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const promoteJob = namedJobBlock(workflow, 'promote');
    const packageJob = namedJobBlock(workflow, 'package_secure_codex');
    const checkout = namedStepBlock(packageJob, 'Checkout exact promoted commit');
    const prepare = namedStepBlock(packageJob, 'Prepare exact promoted source');

    assert.match(promoteJob, /outputs:[\s\S]*promoted_sha:\s*\$\{\{\s*steps\.record-promotion\.outputs\.promoted_sha\s*\}\}/);
    assert.match(promoteJob, /promoted_tree_sha:\s*\$\{\{\s*steps\.record-promotion\.outputs\.promoted_tree_sha\s*\}\}/);
    assert.match(promoteJob, /upstream_ref:\s*\$\{\{\s*steps\.record-promotion\.outputs\.upstream_ref\s*\}\}/);
    assert.match(promoteJob, /upstream_sha:\s*\$\{\{\s*steps\.record-promotion\.outputs\.upstream_sha\s*\}\}/);
    assert.match(promoteJob, /git rev-parse HEAD/);
    assert.match(promoteJob, /git rev-parse 'HEAD\^\{tree\}'/);
    assert.match(checkout, /ref:\s*\$\{\{\s*needs\.promote\.outputs\.promoted_sha\s*\}\}/);
    assert.match(checkout, /fetch-depth:\s*0/);
    assert.match(checkout, /persist-credentials:\s*false/);
    assert.match(prepare, /git diff --quiet/);
    assert.match(prepare, /git diff --cached --quiet/);
    assert.match(prepare, /git status --porcelain=v1 --untracked-files=all/);
    assert.match(prepare, /refs\/tags\/\$\{UPSTREAM_REF\}:refs\/tags\/\$\{UPSTREAM_REF\}/);
    assert.match(prepare, /refs\/tags\/\$\{UPSTREAM_REF\}:refs\/remotes\/upstream\/tags\/\$\{UPSTREAM_REF\}/);
  });

  test('binds the builder and artifact to the promoted SHA, upstream release, and workflow run', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const packageJob = namedJobBlock(workflow, 'package_secure_codex');
    const build = namedStepBlock(packageJob, 'Build secure Codex bundle');
    const upload = namedStepBlock(packageJob, 'Upload secure Codex bundle');

    assert.match(build, /node \.\/\.github\/scripts\/build-secure-codex-bundle\.mjs/);
    assert.match(build, /--promoted-sha "\$PROMOTED_SHA"/);
    assert.match(build, /--promoted-tree-sha "\$PROMOTED_TREE_SHA"/);
    assert.match(build, /--upstream-ref "\$UPSTREAM_REF"/);
    assert.match(build, /--upstream-sha "\$UPSTREAM_SHA"/);
    assert.match(build, /--expected-version "\$EXPECTED_VERSION"/);
    assert.match(build, /--run-id "\$GITHUB_RUN_ID"/);
    assert.match(build, /--run-attempt "\$GITHUB_RUN_ATTEMPT"/);
    assert.match(upload, /secure-codex-bundle\.tar/);
    assert.match(upload, /secure-codex-manifest\.json/);
    assert.match(packageJob, /artifact_name:\s*\$\{\{\s*steps\.artifact-name\.outputs\.artifact_name\s*\}\}/);
    assert.match(packageJob, /artifact_digest:\s*\$\{\{\s*steps\.upload-bundle\.outputs\.artifact-digest\s*\}\}/);
    assert.match(upload, /name:\s*\$\{\{\s*steps\.artifact-name\.outputs\.artifact_name\s*\}\}/);
  });

  test('isolates the environment-protected SSH signing key from candidate code and uploads only signed bundle files', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const packageJob = namedJobBlock(workflow, 'package_secure_codex');
    const signingJob = namedJobBlock(workflow, 'sign_secure_codex');
    const download = namedStepBlock(signingJob, 'Download exact unsigned secure Codex bundle');
    const sign = namedStepBlock(signingJob, 'Sign and self-verify secure Codex manifest');
    const upload = namedStepBlock(signingJob, 'Upload signed secure Codex bundle');

    assert.match(packageJob, /permissions:\n\s+contents:\s*read/);
    assert.doesNotMatch(packageJob, /contents:\s*write|id-token:\s*write|attestations:\s*write|GH_PUSH_TOKEN|github\.token/);
    assert.match(signingJob, /environment:\s*gsd-bundle-signing/);
    assert.match(signingJob, /permissions:\n\s+contents:\s*read/);
    assert.doesNotMatch(signingJob, /actions\/checkout@|id-token:\s*write|attestations:\s*write|contents:\s*write/);
    assert.match(signingJob, /SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\.GSD_BUNDLE_SIGNING_KEY\s*\}\}/);
    assert.match(signingJob, /EXPECTED_SIGNING_FINGERPRINT:\s*\$\{\{\s*vars\.GSD_BUNDLE_SIGNING_PUBLIC_FINGERPRINT\s*\}\}/);
    assert.match(download, /uses:\s*actions\/download-artifact@[0-9a-f]{40}/);
    assert.match(download, /name:\s*\$\{\{\s*needs\.package_secure_codex\.outputs\.artifact_name\s*\}\}/);
    assert.doesNotMatch(download, /GSD_BUNDLE_SIGNING_KEY|SIGNING_PRIVATE_KEY/);
    assert.doesNotMatch(upload, /GSD_BUNDLE_SIGNING_KEY|SIGNING_PRIVATE_KEY/);
    assert.match(sign, /SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\.GSD_BUNDLE_SIGNING_KEY\s*\}\}/);
    assert.match(sign, /env -u SIGNING_PRIVATE_KEY/);
    assert.match(sign, /ssh-keygen -Y sign/);
    assert.match(sign, /ssh-keygen -Y verify/);
    assert.match(sign, /install -m 0600 \/dev\/null "\$key_file"/);
    assert.match(sign, /chmod 0600 "\$key_file"/);
    assert.match(sign, /trap cleanup EXIT/);
    assert.match(sign, /trap 'exit 1' HUP INT TERM/);
    assert.match(sign, /gsd-secure-codex-bundle@imrman\.local/);
    assert.match(sign, /gsd-bundle-signing@imrman\.local/);
    assert.match(upload, /secure-codex-bundle\.tar/);
    assert.match(upload, /secure-codex-manifest\.json/);
    assert.match(upload, /secure-codex-manifest\.json\.sig/);
    assert.doesNotMatch(upload, /\$\{\{\s*runner\.temp\s*\}\}\/secure-codex-signed-output\/?\s*$/m);

    for (const jobName of ['resolve', 'validate', 'attest', 'promote', 'package_secure_codex']) {
      const job = namedJobBlock(workflow, jobName);
      assert.doesNotMatch(job, /id-token:\s*write|attestations:\s*write/, `${jobName} must not mint provenance`);
    }
    assert.doesNotMatch(workflow, /actions\/attest-build-provenance@/);
  });
});
