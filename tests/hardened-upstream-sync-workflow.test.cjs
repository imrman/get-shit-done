// allow-test-rule: workflow-yaml-release-policy-is-the-product
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'hardened-upstream-sync.yml');

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
});
