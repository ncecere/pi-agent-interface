import type { Config } from './config.ts';
import type { User } from './session.ts';
import type { PlatformUsageRow } from './usage.ts';

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

export interface PlatformTemplate {
  id: string;
  slug: string;
  name: string;
  description?: string;
  teamId?: string | null;
}

/** How long the list of this app's agents is trusted before being asked again. */
const MANAGED_TTL_MS = 10_000;

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
  private templateCache: { at: number; list: PlatformTemplate[] } | null = null;
  private managed: { at: number; byKey: Map<string, PlatformAgent> } | null = null;
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

  /** The models published to the team, read at most every five minutes. */
  async teamModels(): Promise<PlatformModel[]> {
    if (!this.models || Date.now() - this.models.at > MODELS_TTL_MS) {
      const team = encodeURIComponent(this.config.platformTeam);
      this.models = {
        at: Date.now(),
        list: await this.json<PlatformModel[]>(`/v1/teams/${team}/models`),
      };
    }
    return this.models.list;
  }

  /**
   * A model's id, given its id or name, if it is published to the team and
   * enabled; otherwise null. Null always means "leave the model alone": an
   * agent on a model that is not published does not start.
   */
  async resolveModelId(wanted: string | null | undefined): Promise<string | null> {
    if (!wanted) return null;
    let list: PlatformModel[];
    try {
      list = await this.teamModels();
    } catch (error) {
      console.warn(
        "[platform] the team's models could not be listed; agent models are left as they are",
        error,
      );
      return null;
    }
    const model = list.find((candidate) => candidate.id === wanted || candidate.name === wanted);
    if (!model?.enabled) {
      if (!this.warnedModel) {
        this.warnedModel = true;
        console.warn(
          `[platform] model "${wanted}" is not published to team ${this.config.platformTeam}; agent models are left as they are`,
        );
      }
      return null;
    }
    this.warnedModel = false;
    return model.id;
  }

  /** AGENT_MODEL, resolved (the environment's default; the admin setting takes precedence, see app.ts). */
  configuredModelId(): Promise<string | null> {
    return this.resolveModelId(this.config.agentModel);
  }

  /** Templates the team may deploy: the platform's catalog and the team's own. Read at most every five minutes. */
  async templates(): Promise<PlatformTemplate[]> {
    if (!this.templateCache || Date.now() - this.templateCache.at > MODELS_TTL_MS) {
      const team = encodeURIComponent(this.config.platformTeam);
      const [catalog, own] = await Promise.all([
        this.json<PlatformTemplate[]>('/v1/agent-templates'),
        this.json<PlatformTemplate[]>(`/v1/teams/${team}/agent-templates`).catch(() => []),
      ]);
      const byId = new Map([...catalog, ...own].map((template) => [template.id, template]));
      this.templateCache = { at: Date.now(), list: [...byId.values()] };
    }
    return this.templateCache.list;
  }

  /** Every agent this app manages, by key, in one call (read at most every 10 seconds). */
  async managedAgents(): Promise<Map<string, PlatformAgent>> {
    if (!this.managed || Date.now() - this.managed.at > MANAGED_TTL_MS) {
      const agents = await this.json<PlatformAgent[]>('/v1/agents?includeManaged=true');
      for (const agent of agents) this.remember(agent);
      this.managed = {
        at: Date.now(),
        byKey: new Map(
          agents.filter((agent) => agent.externalKey).map((agent) => [agent.externalKey!, agent]),
        ),
      };
    }
    return this.managed.byKey;
  }

  /** The team's usage report: per agent or per day, for a range of days (UTC). */
  async usage(groupBy: 'agent' | 'day', from: string, to: string): Promise<PlatformUsageRow[]> {
    const team = encodeURIComponent(this.config.platformTeam);
    const query = new URLSearchParams({ groupBy, from, to });
    return (await this.json<{ rows: PlatformUsageRow[] }>(`/v1/teams/${team}/usage?${query}`)).rows;
  }

  /** After a change: the next read asks the platform again. */
  private changed() {
    this.managed = null;
  }

  /**
   * The agent with this key, created the first time (idempotent on the
   * platform) and moved onto `modelId` if it is on another one.
   */
  async ensureAgent(
    key: string,
    spec: {
      name: string;
      description: string;
      template?: string;
      templateId?: string;
      modelId?: string | null;
    },
  ): Promise<PlatformAgent> {
    const team = encodeURIComponent(this.config.platformTeam);
    const agent = await this.json<PlatformAgent>(
      `/v1/teams/${team}/agents/by-key/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: spec.name.slice(0, 100),
          description: spec.description.slice(0, 2000),
          ...(spec.templateId
            ? { templateId: spec.templateId }
            : spec.template
              ? { template: spec.template }
              : {}),
          // Applies to a new agent; an existing one is moved below.
          ...(spec.modelId ? { modelId: spec.modelId } : {}),
        }),
      },
    );
    this.changed();
    this.remember(agent);
    return spec.modelId ? this.moveToModel(agent, spec.modelId) : agent;
  }

  /** The person's assistant, created the first time (idempotent on the platform), on AGENT_MODEL if one is set. */
  async ensureAssistant(user: User): Promise<PlatformAgent> {
    return this.ensureAgent(agentKeyFor(user), {
      // Named for the team's owners, who see every person's agent in the console.
      name: `${this.config.agentName} · ${user.name || user.email}`,
      description: `${this.config.agentName} for ${user.email || user.name}`,
      ...(this.config.agentTemplate ? { template: this.config.agentTemplate } : {}),
      modelId: await this.configuredModelId(),
    });
  }

  /** Changes an agent (its name, its model), with its revision; once more from the latest if it changed meanwhile. */
  async patchAgent(
    agent: PlatformAgent,
    body: { name?: string; description?: string; modelId?: string },
  ) {
    const patch = (revision: number | undefined) =>
      this.json<PlatformAgent>(`/v1/agents/${encodeURIComponent(agent.id)}`, {
        method: 'PATCH',
        headers: revision === undefined ? {} : { 'If-Match': `"${revision}"` },
        body: JSON.stringify(body),
      });
    try {
      return await patch(agent.revision);
    } catch (error) {
      if (!(error instanceof PlatformError && error.status === 412)) throw error;
      const latest = await this.json<PlatformAgent>(`/v1/agents/${encodeURIComponent(agent.id)}`);
      return await patch(latest.revision);
    } finally {
      this.changed();
    }
  }

  /** Deletes an agent and all its conversations. */
  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.json(`/v1/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof PlatformError && error.status === 404)) throw error;
    } finally {
      this.keys.delete(agentId);
      this.changed();
    }
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
    try {
      const latest = await this.patchAgent(agent, { modelId });
      return latest.model?.id === modelId ? latest : agent;
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
