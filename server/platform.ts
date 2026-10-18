import type { Config } from './config.ts';
import type { User } from './session.ts';

/**
 * The platform, as this app's team service account. The key can reach every
 * agent the app has made, for every person, so this module is the only place
 * that uses it, and `ownsAgent` is the check that keeps each person to their
 * own agents.
 */

export interface PlatformAgent {
  id: string;
  name: string;
  description: string;
  externalKey?: string | null;
  enabled: boolean;
  running: boolean;
  [key: string]: unknown;
}

export class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`platform ${status}`);
  }
}

/** The agent key of a person's assistant. More agents per person will be `u:<id>:<slot>`. */
export const agentKeyFor = (user: User) => `u:${user.id}`;

/** Whether this agent is one of this person's: their assistant, or one of their other agents. */
export function ownsAgent(user: User, agent: Pick<PlatformAgent, 'externalKey'>): boolean {
  const key = agent.externalKey ?? '';
  const own = agentKeyFor(user);
  return key === own || key.startsWith(`${own}:`);
}

export class Platform {
  /** Agent ID → its key, learned as agents are seen; keys never change. */
  private readonly keys = new Map<string, string>();

  constructor(private readonly config: Config) {}

  /** A request to the platform with the service key. Bodies and errors are passed on as they are. */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.config.platformServiceKey}`);
    if (init.body !== undefined && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json');
    return fetch(new URL(path, this.config.platformUrl), { ...init, headers, redirect: 'manual' });
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init);
    const text = await response.text();
    if (!response.ok) throw new PlatformError(response.status, text);
    return (JSON.parse(text) as { data: T }).data;
  }

  private remember(agent: PlatformAgent): PlatformAgent {
    if (agent.externalKey) this.keys.set(agent.id, agent.externalKey);
    return agent;
  }

  /** The person's assistant, created the first time (idempotent on the platform). */
  async ensureAssistant(user: User): Promise<PlatformAgent> {
    const team = encodeURIComponent(this.config.platformTeam);
    const key = encodeURIComponent(agentKeyFor(user));
    const agent = await this.json<PlatformAgent>(`/v1/teams/${team}/agents/by-key/${key}`, {
      method: 'PUT',
      body: JSON.stringify({
        // Named for the team's owners, who see every person's agent in the console.
        name: `${this.config.agentName} · ${user.name || user.email}`.slice(0, 100),
        description: `${this.config.agentName} for ${user.email || user.name}`.slice(0, 2000),
        ...(this.config.agentTemplate ? { template: this.config.agentTemplate } : {}),
      }),
    });
    return this.remember(agent);
  }

  /** Whether the agent is this person's, from what is known or else from the platform. */
  async isOwnAgent(user: User, agentId: string): Promise<boolean> {
    let key = this.keys.get(agentId);
    if (key === undefined) {
      try {
        const agent = this.remember(
          await this.json<PlatformAgent>(`/v1/agents/${encodeURIComponent(agentId)}`),
        );
        key = agent.externalKey ?? '';
      } catch (error) {
        if (error instanceof PlatformError && (error.status === 404 || error.status === 403))
          return false;
        throw error;
      }
    }
    return ownsAgent(user, { externalKey: key });
  }
}
