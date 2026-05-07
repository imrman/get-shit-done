#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// SessionStart banner that surfaces GSD update availability when GSD's
// statusline isn't installed. Reads the cache that gsd-check-update-worker.js
// writes to ~/.cache/gsd/gsd-update-check.json.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const RATE_LIMIT_SECONDS = 24 * 60 * 60;

function buildBannerOutput(state) {
  const { cache, parseError, suppressFailureWarning } = state || {};
  if (parseError) {
    if (suppressFailureWarning) return null;
    return { systemMessage: 'GSD update check failed.' };
  }
  if (!cache) return null;
  if (!cache.update_available) return null;
  const installed = cache.installed || 'unknown';
  const latest = cache.latest || 'unknown';
  return {
    systemMessage: `GSD update available: ${installed} → ${latest}. Run /gsd-update.`,
  };
}

function readCache(cacheFile) {
  let cache = null;
  let parseError = false;
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      cache = JSON.parse(raw);
    }
  } catch (e) {
    parseError = e instanceof SyntaxError;
  }
  return { cache, parseError };
}

function shouldSuppressFailureWarning(sentinelFile, nowSeconds) {
  try {
    if (!fs.existsSync(sentinelFile)) return false;
    const last = parseInt(fs.readFileSync(sentinelFile, 'utf8').trim(), 10);
    if (!Number.isFinite(last)) return false;
    return nowSeconds - last < RATE_LIMIT_SECONDS;
  } catch (e) {
    return false;
  }
}

function recordFailureWarning(sentinelFile, nowSeconds) {
  try {
    fs.writeFileSync(sentinelFile, String(nowSeconds));
  } catch (e) {}
}

function main() {
  const cacheDir = path.join(os.homedir(), '.cache', 'gsd');
  const cacheFile = path.join(cacheDir, 'gsd-update-check.json');
  const sentinelFile = path.join(cacheDir, 'banner-failure-warned-at');
  const now = Math.floor(Date.now() / 1000);

  const { cache, parseError } = readCache(cacheFile);
  const suppressFailureWarning = parseError
    ? shouldSuppressFailureWarning(sentinelFile, now)
    : false;
  const output = buildBannerOutput({ cache, parseError, suppressFailureWarning });

  if (parseError && !suppressFailureWarning) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch (e) {}
    recordFailureWarning(sentinelFile, now);
  }

  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
}

if (require.main === module) main();

module.exports = {
  buildBannerOutput,
  readCache,
  shouldSuppressFailureWarning,
  RATE_LIMIT_SECONDS,
};
