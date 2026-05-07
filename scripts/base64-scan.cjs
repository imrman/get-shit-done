#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MIN_BLOB_LENGTH = 40;
const MAX_BLOB_LENGTH = 8192;
const IGNORE_FILE = '.base64scanignore';

const decodedPatterns = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system\s+prompt/i,
  /<\/?system>/i,
  /<\/?assistant>/i,
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /override\s+(system|safety|security)/i,
  /pretend\s+(you|to)\s+/i,
  /act\s+as\s+(a|an|if)/i,
  /jailbreak/i,
  /bypass\s+(safety|content|security)/i,
  /eval\s*\(/i,
  /exec\s*\(/i,
  /rm\s+-rf/i,
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*sh/i,
];

function usage() {
  process.stderr.write(`Usage: scripts/base64-scan.sh --diff [base] | --file <path> | --dir <path> | --stdin\n`);
  process.exit(2);
}

function loadIgnorelist() {
  if (!fs.existsSync(IGNORE_FILE)) return new Set();
  const lines = fs.readFileSync(IGNORE_FILE, 'utf8').split(/\r?\n/);
  return new Set(lines.map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
}

function shouldSkipFile(file) {
  if (/(^|\/)node_modules\//.test(file)) return true;
  if (/(^|\/)package-lock\.json$/.test(file)) return true;
  if (/(^|\/)yarn\.lock$/.test(file)) return true;
  if (/(^|\/)pnpm-lock\.yaml$/.test(file)) return true;
  if (/(^|\/)base64-scan\.sh$/.test(file)) return true;
  if (/(^|\/)base64-scan\.cjs$/.test(file)) return true;
  if (/(^|\/)security-scan\.test\.cjs$/.test(file)) return true;
  return /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|otf|zip|tar|gz|bz2|xz|7z|pdf|docx?|xlsx?)$/i.test(file);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = full.split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (/(^|\/)(node_modules|\.git|dist)(\/|$)/.test(rel)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function collectFiles(argv) {
  const mode = argv[0];
  if (mode === '--diff') {
    const base = argv[1] || 'origin/main';
    try {
      return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }
  if (mode === '--file') {
    const file = argv[1];
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return [file];
    process.stderr.write(`Error: file not found: ${file || ''}\n`);
    process.exit(2);
  }
  if (mode === '--dir') {
    const dir = argv[1];
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return walk(dir);
    process.stderr.write(`Error: directory not found: ${dir || ''}\n`);
    process.exit(2);
  }
  if (mode === '--stdin') {
    return fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
  }
  usage();
}

function isMostlyPrintable(buffer) {
  if (buffer.length === 0) return false;
  let printable = 0;
  for (const byte of buffer) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable += 1;
  }
  return (printable * 100 / buffer.length) >= 70;
}

function isCanonicalBase64(blob, decoded) {
  return decoded.toString('base64').replace(/=+$/u, '') === blob.replace(/=+$/u, '');
}

function shouldDecodeCandidate(blob, line) {
  if (blob.length < MIN_BLOB_LENGTH || blob.length > MAX_BLOB_LENGTH) return false;
  if (blob.length % 4 !== 0) return false;
  if (!/[+/=]/u.test(blob) && !/(base64|encoded|payload|blob|secret|token|data|["'`:={}])/iu.test(line)) return false;
  return true;
}

function scanFile(file, ignored) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  let found = false;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/data:[a-zA-Z]+\/[a-zA-Z0-9.+-]+;base64,/u.test(line)) continue;

    for (const match of line.matchAll(/[A-Za-z0-9+/]{40,}={0,3}/gu)) {
      const blob = match[0];
      if (ignored.has(blob) || !shouldDecodeCandidate(blob, line)) continue;

      const decoded = Buffer.from(blob, 'base64');
      if (!isCanonicalBase64(blob, decoded) || !isMostlyPrintable(decoded)) continue;
      const decodedText = decoded.toString('utf8');

      const pattern = decodedPatterns.find((candidate) => candidate.test(decodedText));
      if (!pattern) continue;

      if (!found) {
        process.stdout.write(`FAIL: ${file}\n`);
        found = true;
      }
      process.stdout.write(`  line ${index + 1}: base64 blob decodes to suspicious content\n`);
      process.stdout.write(`    blob: ${blob.slice(0, 60)}...\n`);
      process.stdout.write(`    decoded: ${decodedText.slice(0, 120)}\n`);
      process.stdout.write(`    matched: ${pattern.source}\n`);
      break;
    }
  }
  return found;
}

function main() {
  if (process.argv.length <= 2) usage();
  const ignored = loadIgnorelist();
  const files = collectFiles(process.argv.slice(2));

  if (files.length === 0) {
    process.stdout.write('base64-scan: no files to scan\n');
    return 0;
  }

  let total = 0;
  let failed = 0;
  for (const file of files) {
    if (!file || shouldSkipFile(file)) continue;
    total += 1;
    if (scanFile(file, ignored)) failed += 1;
  }

  process.stdout.write(`\nbase64-scan: scanned ${total} files, ${failed} with findings\n`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = main();
