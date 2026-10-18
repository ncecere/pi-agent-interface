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
  revision?: number;
  /** Absent: it runs on the platform's default model. */
  model?: { id: string; name: string; source: 'agent' | 'template'; available: boolean } | null;
  [key: string]: unknown;
}

export interface PlatformModel {
  id: string;
  name: string;
  enabled: boolean;
}

/** How long the team's published models are trusted before being asked again. */
const MODELS_TTL_MS = 5 * 60_000;
/** After a failed model change, how long before that agent is tried again (not on every page load). */
const MODEL_RETRY_MS = 5 * 60_000;

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
  private models: { at: number; list: PlatformModel[] } | null = null;
  /** Agents whose model could not be changed, and when to try again. */
  private readonly modelRetryAt = new Map<string, number>();
  /** Said once per process, not on every request. */
  private warnedModel = false;

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

  /**
   * The id of AGENT_MODEL among the models published to the team, or null:
   * none is configured, it is not published (or is disabled), or the list
   * cannot be read. Null always means "leave the model alone": an agent on a
   * model that is not published does not start, so the app never sets one.
   */
  async configuredModelId(): Promise<string | null> {
    const wanted = this.config.agentModel;
    if (!wanted) return null;
    if (!this.models || Date.now() - this.models.at > MODELS_TTL_MS) {
      try {
        const team = encodeURIComponent(this.config.platformTeam);
        this.models = {
          at: Date.now(),
          list: await this.json<PlatformModel[]>(`/v1/teams/${team}/models`),
        };
      } catch (error) {
        console.warn(
          "[platform] the team's models could not be listed; agent models are left as they are",
          error,
        );
        return null;
      }
    }
    const model = this.models.list.find(
      (candidate) => candidate.id === wanted || candidate.name === wanted,
    );
    if (!model?.enabled) {
      if (!this.warnedModel) {
        this.warnedModel = true;
        console.warn(
          `[platform] AGENT_MODEL "${wanted}" is not a model published to team ${this.config.platformTeam}; agent models are left as they are`,
        );
      }
      return null;
    }
    this.warnedModel = false;
    return model.id;
  }

  /** The person's assistant, created the first time (idempotent on the platform), on AGENT_MODEL if one is set. */
  async ensureAssistant(user: User): Promise<PlatformAgent> {
    const team = encodeURIComponent(this.config.platformTeam);
    const key = encodeURIComponent(agentKeyFor(user));
    const modelId = await this.configuredModelId();
    const agent = await this.json<PlatformAgent>(`/v1/teams/${team}/agents/by-key/${key}`, {
      method: 'PUT',
      body: JSON.stringify({
        // Named for the team's owners, who see every person's agent in the console.
        name: `${this.config.agentName} · ${user.name || user.email}`.slice(0, 100),
        description: `${this.config.agentName} for ${user.email || user.name}`.slice(0, 2000),
        ...(this.config.agentTemplate ? { template: this.config.agentTemplate } : {}),
        // Applies to a new agent; an existing one is moved below.
        ...(modelId ? { modelId } : {}),
      }),
    });
    return this.remember(modelId ? await this.moveToModel(agent, modelId) : agent);
  }

  /**
   * Puts an existing agent on the model. It takes effect when the agent next
   * starts; an agent at work is not interrupted. A failure is logged and the
   * agent is returned as it is: nobody is kept out of their assistant because
   * its model could not be changed.
   */
  private async moveToModel(agent: PlatformAgent, modelId: string): Promise<PlatformAgent> {
    if (agent.model?.id === modelId) return agent;
    if ((this.modelRetryAt.get(agent.id) ?? 0) > Date.now()) return agent;
    const patch = (revision: number | undefined) =>
      this.json<PlatformAgent>(`/v1/agents/${encodeURIComponent(agent.id)}`, {
        method: 'PATCH',
        headers: revision === undefined ? {} : { 'If-Match': `"${revision}"` },
        body: JSON.stringify({ modelId }),
      });
    try {
      try {
        return await patch(agent.revision);
      } catch (error) {
        // Changed in the meantime (412): once more, from the latest.
        if (!(error instanceof PlatformError && error.status === 412)) throw error;
        const latest = await this.json<PlatformAgent>(`/v1/agents/${encodeURIComponent(agent.id)}`);
        return latest.model?.id === modelId ? latest : await patch(latest.revision);
      }
    } catch (error) {
      this.modelRetryAt.set(agent.id, Date.now() + MODEL_RETRY_MS);
      console.warn(`[platform] agent ${agent.id} could not be moved to model ${modelId}`, error);
      return agent;
    }
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
