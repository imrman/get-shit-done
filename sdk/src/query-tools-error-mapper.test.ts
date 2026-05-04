import { describe, expect, it } from 'vitest';
import { ErrorClassification, GSDError } from './errors.js';
import { toGSDToolsError } from './query-tools-error-mapper.js';

describe('query tools error mapper', () => {
  it('maps GSDError to GSDToolsError exit code', () => {
    const err = toGSDToolsError('state', ['load'], new GSDError('bad input', ErrorClassification.Validation));
    expect(err.exitCode).toBe(10);
    expect(err.message).toBe('bad input');
  });

  it('attaches timeout classification when message indicates timeout', () => {
    const err = toGSDToolsError('state', ['load'], new Error('gsd-tools timed out after 1234ms: state load'));
    expect(err.classification).toEqual({ kind: 'timeout', timeoutMs: 1234 });
  });

  it('does not attach timeout classification for non-timeout failures', () => {
    const err = toGSDToolsError('state', ['load'], new Error('boom'));
    expect(err.classification).toBeUndefined();
  });
});
