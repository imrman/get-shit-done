#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MIN_BLOB_LENGTH = 40;
const MAX_DECODE_DEPTH = 3;
const MAX_FRAGMENT_GAP_LINES = 16;
const MAX_RECONSTRUCTED_FRAGMENTS = 128;
const MAX_RECONSTRUCTED_BLOB_LENGTH = 65536;
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
  /AKIA[0-9A-Z]{16}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /(?:ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /s[pk]_live_[A-Za-z0-9]{24,}/,
  /xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}/,
  /AIza[A-Za-z0-9_-]{35}/,
  /npm_[A-Za-z0-9]{36}/,
];

function usage() {
  process.stderr.write(`Usage: scripts/base64-scan.sh --diff [base] | --file <path> | --dir <path> | --stdin\n`);
  process.exit(2);
}

function loadIgnorelist(trustedBase) {
  let content = '';
  if (trustedBase) {
    try {
      content = execFileSync('git', ['show', `${trustedBase}:${IGNORE_FILE}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      content = '';
    }
  } else if (fs.existsSync(IGNORE_FILE)) {
    content = fs.readFileSync(IGNORE_FILE, 'utf8');
  }
  if (!content) return new Set();
  const lines = content.split(/\r?\n/);
  return new Set(lines.map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
}

function shouldSkipFile(file, mode) {
  if (/(^|\/)node_modules\//.test(file)) return true;
  if (/(^|\/)package-lock\.json$/.test(file)) return true;
  if (/(^|\/)yarn\.lock$/.test(file)) return true;
  if (/(^|\/)pnpm-lock\.yaml$/.test(file)) return true;
  if (mode !== '--diff' && /(^|\/)base64-scan\.sh$/.test(file)) return true;
  if (mode !== '--diff' && /(^|\/)base64-scan\.cjs$/.test(file)) return true;
  if (mode !== '--diff' && isRepoSecurityScanTest(file)) return true;
  return /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|otf|zip|tar|gz|bz2|xz|7z|pdf|docx?|xlsx?)$/i.test(file);
}

function normalizePathForMatching(file) {
  return file.split(path.sep).join('/').replace(/^\.\//u, '');
}

function isRepoSecurityScanTest(file) {
  const normalized = normalizePathForMatching(file);
  if (normalized === 'tests/security-scan.test.cjs') return true;
  return normalizePathForMatching(path.resolve(file)) === normalizePathForMatching(path.join(process.cwd(), 'tests/security-scan.test.cjs'));
}

function sanitizeFileId(file) {
  return path.basename(String(file).replace(/\\/gu, '/'))
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(
      /(^|[^A-Za-z0-9])(customer|secret|token|password|passwd|credentials?|private|api[-_]?key|access[-_]?key)(?=[^A-Za-z0-9]|$)/giu,
      '$1[redacted]'
    )
    .replace(/AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|(?:ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|s[pk]_live_[A-Za-z0-9]{24,}|xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36}/gu, '[redacted]');
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

function isReadableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function rejectsNewlinePathFragments(files) {
  for (let start = 0; start < files.length; start += 1) {
    let candidate = files[start];
    for (let end = start + 1; end < files.length; end += 1) {
      candidate += `\n${files[end]}`;
      if (isReadableFile(candidate)) return true;
    }
  }
  return false;
}

function gitNulPaths(args, errorMessage) {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    process.stderr.write(`${errorMessage}\n`);
    process.exit(2);
  }
}

function collectDiffFiles(base) {
  const seen = new Set();
  const files = [];
  const addFiles = (candidates) => {
    for (const file of candidates) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  };

  addFiles(gitNulPaths(['diff', '-z', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], `Error: git diff failed for base: ${base}`));
  addFiles(gitNulPaths(['diff', '-z', '--name-only', '--cached', '--diff-filter=ACMR'], 'Error: git staged diff failed'));
  addFiles(gitNulPaths(['diff', '-z', '--name-only', '--diff-filter=ACMR'], 'Error: git unstaged diff failed'));
  addFiles(gitNulPaths(['ls-files', '-z', '--others', '--exclude-standard'], 'Error: git untracked file listing failed'));
  return files;
}

function collectFiles(argv) {
  const mode = argv[0];
  if (mode === '--diff') {
    const base = argv[1] || 'origin/main';
    return collectDiffFiles(base);
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
    const files = fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
    if (rejectsNewlinePathFragments(files)) {
      process.stderr.write('Error: stdin path stream cannot represent newline-containing paths\n');
      process.exit(2);
    }
    if (files.some((file) => !isReadableFile(file))) {
      process.stderr.write('Error: stdin path is not readable\n');
      process.exit(2);
    }
    return files;
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

function toStandardBase64(blob) {
  return blob.replace(/-/gu, '+').replace(/_/gu, '/');
}

function isCanonicalBase64(blob, decoded) {
  return decoded.toString('base64').replace(/=+$/u, '') === toStandardBase64(blob).replace(/=+$/u, '');
}

function normalizeBase64Candidate(blob) {
  const standardBlob = toStandardBase64(blob);
  const remainder = standardBlob.length % 4;
  if (remainder === 1) return '';
  return remainder === 0 ? standardBlob : standardBlob + '='.repeat(4 - remainder);
}

function shouldDecodeCandidate(blob, line) {
  if (blob.length < MIN_BLOB_LENGTH) return false;
  if (blob.length % 4 === 1) return false;
  if (!/[+/=_-]/u.test(blob) && line.trim() !== blob && !/(base64|encoded|payload|blob|secret|token|data|["'`:={}])/iu.test(line)) return false;
  return true;
}

function lineNumberAtOffset(content, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function quotedFragmentCandidates(content) {
  const candidates = [];
  const quotedRun = /(["'`][A-Za-z0-9+/_-]{1,}={0,3}["'`])(?:\s*[+,]?\s*["'`][A-Za-z0-9+/_-]{1,}={0,3}["'`])+/gu;
  for (const match of content.matchAll(quotedRun)) {
    const blob = [...match[0].matchAll(/["'`]([A-Za-z0-9+/_-]{1,}={0,3})["'`]/gu)]
      .map((fragment) => fragment[1])
      .join('');
    candidates.push({ blob, lineNumber: lineNumberAtOffset(content, match.index || 0), context: match[0] });
  }
  return candidates;
}

function assignmentFragmentCandidates(content) {
  const fragments = [];
  const lines = content.split(/\r?\n/u);
  const assignment = /(?:^|[;,]\s*)(?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*(["'`])([A-Za-z0-9+/_-]{1,}={0,3})\1/gu;

  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(assignment)) {
      fragments.push({ value: match[2], lineNumber: index + 1 });
    }
  }

  const candidates = [];
  for (let start = 0; start < fragments.length; start += 1) {
    let blob = '';
    for (let end = start; end < fragments.length && end < start + MAX_RECONSTRUCTED_FRAGMENTS; end += 1) {
      if (fragments[end].lineNumber - fragments[start].lineNumber > MAX_FRAGMENT_GAP_LINES) break;
      blob += fragments[end].value;
      if (blob.length > MAX_RECONSTRUCTED_BLOB_LENGTH) break;
      if (end > start) {
        candidates.push({
          blob,
          lineNumber: fragments[start].lineNumber,
          context: 'base64 assignment fragments',
        });
      }
    }
  }
  return candidates;
}

function scanFile(file, ignored) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  let found = false;
  const seenBlobs = new Set();
  const checkCandidate = (blob, lineNumber, context) => {
    if (seenBlobs.has(`${lineNumber}:${blob}`)) return false;
    seenBlobs.add(`${lineNumber}:${blob}`);
    if (ignored.has(blob) || !shouldDecodeCandidate(blob, context)) return false;

    let currentBlob = blob;
    for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
      const normalizedBlob = normalizeBase64Candidate(currentBlob);
      if (!normalizedBlob) return false;
      const decoded = Buffer.from(normalizedBlob, 'base64');
      if (!isCanonicalBase64(currentBlob, decoded) || !isMostlyPrintable(decoded)) return false;
      const decodedText = decoded.toString('utf8');
      const pattern = decodedPatterns.find((candidate) => candidate.test(decodedText));

      if (pattern) {
        if (!found) {
          process.stdout.write(`FAIL: ${sanitizeFileId(file)}\n`);
          found = true;
        }
        process.stdout.write(`  line ${lineNumber}: base64 blob decodes to suspicious content\n`);
        process.stdout.write(`    matched: ${pattern.source}\n`);
        return true;
      }

      if (!/^[A-Za-z0-9+/_-]{40,}={0,3}$/u.test(decodedText)) return false;
      currentBlob = decodedText;
    }
    return false;
  };

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const scanLine = line;

    for (const match of scanLine.matchAll(/[A-Za-z0-9+/_-]{40,}={0,3}/gu)) {
      if (checkCandidate(match[0], index + 1, scanLine)) break;
    }
  }
  for (const candidate of quotedFragmentCandidates(content)) {
    checkCandidate(candidate.blob, candidate.lineNumber, candidate.context);
  }
  for (const candidate of assignmentFragmentCandidates(content)) {
    checkCandidate(candidate.blob, candidate.lineNumber, candidate.context);
  }
  return found;
}

function main() {
  if (process.argv.length <= 2) usage();
  const argv = process.argv.slice(2);
  const trustedBase = argv[0] === '--diff' ? (argv[1] || 'origin/main') : '';
  const ignored = loadIgnorelist(trustedBase);
  const files = collectFiles(argv);

  if (files.length === 0) {
    process.stdout.write('base64-scan: no files to scan\n');
    return 0;
  }

  let total = 0;
  let failed = 0;
  for (const file of files) {
    if (!file || shouldSkipFile(file, argv[0])) continue;
    total += 1;
    if (scanFile(file, ignored)) failed += 1;
  }

  process.stdout.write(`\nbase64-scan: scanned ${total} files, ${failed} with findings\n`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = main();
