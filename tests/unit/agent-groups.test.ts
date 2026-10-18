import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/api/client';
import { groupAgents } from '../../src/lib/agent-groups';

const agent = (id: string, kind?: Agent['kind']) => ({ id, name: id, kind }) as Agent;

describe('groupAgents', () => {
  it('keeps a team’s agents out of "provided for you" and "your agents"', () => {
    const groups = groupAgents([
      agent('assistant', 'provided'),
      agent('mine', 'personal'),
      agent('research-bot', 'team'),
    ]);
    expect(groups.provided.map((a) => a.id)).toEqual(['assistant']);
    expect(groups.mine.map((a) => a.id)).toEqual(['mine']);
    expect(groups.teams.map((a) => a.id)).toEqual(['research-bot']);
  });

  it('treats an agent with no kind as provided', () => {
    expect(groupAgents([agent('old')]).provided.map((a) => a.id)).toEqual(['old']);
  });
});
