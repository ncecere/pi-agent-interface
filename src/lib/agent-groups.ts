import type { Agent } from '~/api/client';

/**
 * How a person's agents divide up: the ones an administrator provides (their
 * own copy of each), the ones they made, and, in Connect mode, the agents of
 * the shared teams they belong to. An agent with no kind is a provided one
 * (service mode before kinds existed).
 */
export function groupAgents(agents: readonly Agent[]) {
  return {
    provided: agents.filter((agent) => !agent.kind || agent.kind === 'provided'),
    mine: agents.filter((agent) => agent.kind === 'personal'),
    teams: agents.filter((agent) => agent.kind === 'team'),
  };
}
