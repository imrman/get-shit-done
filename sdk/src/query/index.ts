/**
 * Query module entry point — thin facade over registry assembly and helpers.
 */

export {
  buildRegistry,
  createRegistry,
  decorateRegistryMutations,
  QUERY_MUTATION_COMMANDS,
} from './registry-assembly.js';
export { extractField } from './registry.js';
/** Same argv normalization as `gsd-sdk query` — use when calling `registry.dispatch()` with CLI-style `command` + `args`. */
export { normalizeQueryCommand } from './normalize-query-command.js';
export type { QueryResult, QueryHandler } from './utils.js';
