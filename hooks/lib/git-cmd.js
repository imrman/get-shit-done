'use strict';

/**
 * git-cmd.js — token-walk git command classifier.
 *
 * Determines whether a shell command string invokes a specific git subcommand.
 * Handles forms that a naive `^git\s+commit` regex misses:
 *
 *   bare:         git commit -m "..."
 *   -C path:      git -C /some/path commit -m "..."
 *   env-prefix:   GIT_AUTHOR_NAME=x git commit "..."
 *   full-path:    /usr/bin/git commit -m "..."
 */

const path = require('path');

const ARGUMENT_TAKING_FLAGS = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
  '--html-path',
  '--man-path',
  '--info-path',
  '--list-cmds',
]);

const BOOLEAN_FLAGS = new Set([
  '-p', '--paginate', '--no-pager',
  '--no-replace-objects', '--bare',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks',
  '-P', '--no-lazy-fetch',
  '--version', '--help',
]);

function tokenize(cmd) {
  const tokens = [];
  let i = 0;

  while (i < cmd.length) {
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    if (i >= cmd.length) break;

    let token = '';
    while (i < cmd.length && !/\s/.test(cmd[i])) {
      if (cmd[i] === "'") {
        i++;
        while (i < cmd.length && cmd[i] !== "'") token += cmd[i++];
        if (i < cmd.length) i++;
      } else if (cmd[i] === '"') {
        i++;
        while (i < cmd.length && cmd[i] !== '"') token += cmd[i++];
        if (i < cmd.length) i++;
      } else {
        token += cmd[i++];
      }
    }
    if (token) tokens.push(token);
  }

  return tokens;
}

function isGitSubcommand(cmd, sub) {
  if (!cmd || !sub) return false;

  const tokens = tokenize(cmd);
  let i = 0;

  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    i++;
  }

  if (i >= tokens.length) return false;
  const gitToken = tokens[i++];
  if (path.basename(gitToken) !== 'git') return false;

  while (i < tokens.length) {
    const token = tokens[i];
    const eqIdx = token.indexOf('=');
    const flagName = eqIdx !== -1 ? token.slice(0, eqIdx) : token;

    if (ARGUMENT_TAKING_FLAGS.has(flagName)) {
      i += eqIdx !== -1 ? 1 : 2;
      continue;
    }

    if (BOOLEAN_FLAGS.has(token)) {
      i++;
      continue;
    }

    break;
  }

  return i < tokens.length && tokens[i] === sub;
}

module.exports = { isGitSubcommand, tokenize };
