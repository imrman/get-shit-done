/**
 * Workstream utility functions for multi-workstream project support.
 *
 * When --ws <name> is provided, all .planning/ paths are routed to
 * .planning/workstreams/<name>/ instead.
 */

import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { GSDError, ErrorClassification } from './errors.js';

/**
 * Validate a workstream name.
 * Allowed: alphanumeric, hyphens, underscores, dots.
 * Disallowed: empty, spaces, slashes, special chars, path traversal.
 */
export function validateWorkstreamName(name: string): boolean {
  if (!name || name.length === 0) return false;
  // Only allow alphanumeric, hyphens, underscores, dots
  // Must not be ".." or start with ".." (path traversal)
  if (name === '..' || name.startsWith('../')) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Return the relative planning directory path.
 *
 * - Without workstream: `.planning`
 * - With workstream: `.planning/workstreams/<name>`
 */
export function relPlanningPath(workstream?: string): string {
  if (!workstream) return '.planning';
  if (!validateWorkstreamName(workstream)) {
    throw new GSDError(`Invalid workstream name: "${workstream}"`, ErrorClassification.Validation);
  }
  // Use POSIX segments so the same logical path string is used on all platforms (Windows included).
  return posix.join('.planning', 'workstreams', workstream);
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

async function resolveCanonicalPath(path: string, workstream: string): Promise<string> {
  let existingPath = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return resolve(await realpath(existingPath), ...missingSegments.reverse());
    } catch (err: unknown) {
      if (errorCode(err) !== 'ENOENT' && errorCode(err) !== 'ENOTDIR') throw err;
      try {
        await lstat(existingPath);
        throw new GSDError(
          `Workstream path cannot be resolved safely: "${workstream}"`,
          ErrorClassification.Validation,
        );
      } catch (statErr: unknown) {
        if (statErr instanceof GSDError) throw statErr;
        if (errorCode(statErr) !== 'ENOENT' && errorCode(statErr) !== 'ENOTDIR') throw statErr;
      }

      const parent = dirname(existingPath);
      if (parent === existingPath) throw err;
      missingSegments.push(basename(existingPath));
      existingPath = parent;
    }
  }
}

function isStrictlyContained(boundary: string, candidate: string): boolean {
  const fromBoundary = relative(boundary, candidate);
  return fromBoundary !== '' && fromBoundary !== '..' &&
    !fromBoundary.startsWith(`..${sep}`) && !isAbsolute(fromBoundary);
}

/** Reject a missing, symlinked, or out-of-project root .planning directory. */
export async function assertResolvedPlanningContained(projectDir: string): Promise<string> {
  const projectPath = await realpath(projectDir);
  const planningCandidate = resolve(projectDir, '.planning');
  let planningStat;
  try {
    planningStat = await lstat(planningCandidate);
  } catch (err: unknown) {
    if (errorCode(err) === 'ENOENT') {
      throw new GSDError(
        'Root .planning directory must exist before config mutation',
        ErrorClassification.Validation,
      );
    }
    throw err;
  }

  if (planningStat.isSymbolicLink()) {
    throw new GSDError(
      'Root .planning directory must not be a symbolic link',
      ErrorClassification.Validation,
    );
  }
  if (!planningStat.isDirectory()) {
    throw new GSDError(
      'Root .planning path must be a directory',
      ErrorClassification.Validation,
    );
  }

  const planningPath = await realpath(planningCandidate);
  if (!isStrictlyContained(projectPath, planningPath)) {
    throw new GSDError(
      'Resolved .planning boundary escapes project',
      ErrorClassification.Validation,
    );
  }
  return planningPath;
}

/** Reject an unsafe workstream and return its canonical mutation directory. */
export async function assertResolvedWorkstreamContained(
  projectDir: string,
  workstream?: string,
): Promise<string | undefined> {
  if (!workstream) return undefined;

  const planningPath = await assertResolvedPlanningContained(projectDir);

  const expectedWorkstreamsPath = resolve(planningPath, 'workstreams');
  const workstreamsPath = await resolveCanonicalPath(
    resolve(projectDir, '.planning', 'workstreams'),
    workstream,
  );
  if (workstreamsPath !== expectedWorkstreamsPath) {
    throw new GSDError(
      `Resolved workstreams boundary is not the canonical .planning/workstreams directory: "${workstream}"`,
      ErrorClassification.Validation,
    );
  }

  const workstreamPath = await resolveCanonicalPath(
    resolve(projectDir, relPlanningPath(workstream)),
    workstream,
  );
  if (!isStrictlyContained(workstreamsPath, workstreamPath)) {
    throw new GSDError(
      `Resolved workstream path escapes .planning/workstreams: "${workstream}"`,
      ErrorClassification.Validation,
    );
  }

  return workstreamPath;
}
