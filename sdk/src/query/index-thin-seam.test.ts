import { describe, it, expect } from 'vitest';
import * as query from './index.js';
import * as assembly from './registry-assembly.js';
import * as registry from './registry.js';
import * as normalize from './normalize-query-command.js';

describe('query index thin seam', () => {
  it('re-exports registry assembly seam', () => {
    expect(query.createRegistry).toBe(assembly.createRegistry);
    expect(query.buildRegistry).toBe(assembly.buildRegistry);
    expect(query.decorateRegistryMutations).toBe(assembly.decorateRegistryMutations);
    expect(query.QUERY_MUTATION_COMMANDS).toBe(assembly.QUERY_MUTATION_COMMANDS);
  });

  it('re-exports shared query helpers', () => {
    expect(query.extractField).toBe(registry.extractField);
    expect(query.normalizeQueryCommand).toBe(normalize.normalizeQueryCommand);
  });
});
