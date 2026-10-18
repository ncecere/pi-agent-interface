import type { AgentSettings, ProvidedAgent } from './agent-settings.ts';
import type { Connect } from './connect.ts';
import {
  type PlatformAgent,
  PlatformError,
  type PlatformModel,
  type PlatformTemplate,
} from './platform.ts';
import type { Person, Store } from './store.ts';

/**
 * A person's agents in Connect mode, reached with their own token
 * (connect.ts):
 *
 * - **Provided** agents (Admin → Agents) are created in the person's personal
 *   workspace the first time they are listed, one copy per person, from a
 *   catalog template (personal workspaces take catalog templates only). Which
 *   agent is the copy is remembered in the app's database.
 * - **Their own** agents are every other agent in their personal workspace,
 *   whether made here or in the platform's console.
 * - **Team** agents are the agents of the shared teams they belong to.
 *
 * The platform decides what the person may see and use, so there is no
 * ownership check here beyond "is this in their personal workspace" for
 * renaming and deleting.
 */

export interface WorkspaceTeam {
  id: string;
  slug: string;
  name: string;
  kind?: 'team' | 'personal';
}

export type AgentKind = 'provided' | 'personal' | 'team';

export interface AgentView extends PlatformAgent {
  kind: AgentKind;
  /** For team agents: the team's name, to group them by. */
  teamName?: string;
}

export interface WorkspaceSettings {
  agentSettings: () => Promise<AgentSettings>;
  providedAgents: () => Promise<ProvidedAgent[]>;
  /** AGENT_TEMPLATE (a catalog slug) and AGENT_MODEL (a name or id): the environment's defaults. */
  defaultTemplateSlug: string;
  defaultModel: string;
}

const PERSONAL_TTL_MS = 5 * 60_000;
const MODELS_TTL_MS = 5 * 60_000;

/** A failure the person can act on, with the status and code the API answers. */
export class AgentProblem extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class WorkspaceAgents {
  private readonly personalCache = new Map<string, { at: number; team: WorkspaceTeam }>();
  private readonly modelsCache = new Map<string, { at: number; models: PlatformModel[] }>();
  /** One listing at a time per person, so two first visits don't both create the provided agents. */
  private readonly listing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly connect: Connect,
    private readonly store: Store,
    private readonly settings: WorkspaceSettings,
  ) {}

  private async json<T>(personId: string, path: string, init?: RequestInit): Promise<T> {
    const response = await this.connect.fetchAs(personId, path, init);
    const text = await response.text();
    if (!response.ok) throw new PlatformError(response.status, text);
    return text ? (JSON.parse(text) as { data: T }).data : (undefined as T);
  }

  /** The person's personal workspace (the platform makes it at their first sign-in). */
  async personal(personId: string): Promise<WorkspaceTeam> {
    const cached = this.personalCache.get(personId);
    if (cached && Date.now() - cached.at < PERSONAL_TTL_MS) return cached.team;
    const teams = await this.json<WorkspaceTeam[]>(personId, '/v1/teams');
    const team = teams.find((candidate) => candidate.kind === 'personal');
    if (!team)
      throw new AgentProblem(
        409,
        'no_personal_workspace',
        'Your account on the agent platform has no personal workspace. Ask a platform administrator to turn personal workspaces on.',
      );
    this.personalCache.set(personId, { at: Date.now(), team });
    return team;
  }

  /** The models the person's personal workspace may use. */
  async models(personId: string): Promise<PlatformModel[]> {
    const cached = this.modelsCache.get(personId);
    if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
    const team = await this.personal(personId);
    const models = (
      await this.json<PlatformModel[]>(
        personId,
        `/v1/teams/${encodeURIComponent(team.slug)}/models`,
      )
    ).filter((model) => model.enabled);
    this.modelsCache.set(personId, { at: Date.now(), models });
    return models;
  }

  /** The platform's catalog templates: the only ones a personal workspace can deploy. */
  async templates(personId: string): Promise<PlatformTemplate[]> {
    const all = await this.json<PlatformTemplate[]>(personId, '/v1/agent-templates');
    return all.filter((template) => !template.teamId);
  }

  private async resolveModel(personId: string, wanted: string | null | undefined) {
    if (!wanted) return null;
    const models = await this.models(personId);
    return models.find((model) => model.id === wanted || model.name === wanted)?.id ?? null;
  }

  /** The default model for the person: the administrators' choice, else AGENT_MODEL, else the template's. */
  private async defaultModel(personId: string, settings: AgentSettings) {
    return (
      (await this.resolveModel(personId, settings.defaultModelId)) ??
      (await this.resolveModel(personId, this.settings.defaultModel))
    );
  }

  private async allowedTemplates(personId: string, settings: AgentSettings) {
    const templates = await this.templates(personId);
    return settings.allowedTemplateIds === null
      ? templates
      : templates.filter((template) => settings.allowedTemplateIds!.includes(template.id));
  }

  private patch(personId: string, agent: PlatformAgent, body: Record<string, unknown>) {
    const send = (revision: number | undefined) =>
      this.json<PlatformAgent>(personId, `/v1/agents/${encodeURIComponent(agent.id)}`, {
        method: 'PATCH',
        headers: revision === undefined ? {} : { 'If-Match': `"${revision}"` },
        body: JSON.stringify(body),
      });
    return send(agent.revision).catch(async (error) => {
      if (!(error instanceof PlatformError && error.status === 412)) throw error;
      const latest = await this.json<PlatformAgent>(
        personId,
        `/v1/agents/${encodeURIComponent(agent.id)}`,
      );
      return send(latest.revision);
    });
  }

  /** Everything the person may talk to: provided, their own, then their teams'. */
  async list(person: Person): Promise<AgentView[]> {
    const before = this.listing.get(person.id) ?? Promise.resolve();
    const run = before.then(
      () => this.listNow(person),
      () => this.listNow(person),
    );
    this.listing.set(
      person.id,
      run.catch(() => undefined),
    );
    return run;
  }

  private async listNow(person: Person): Promise<AgentView[]> {
    const [settings, provided, copies, team, agents] = await Promise.all([
      this.settings.agentSettings(),
      this.settings.providedAgents(),
      this.store.providedCopies(person.id),
      this.personal(person.id),
      this.json<PlatformAgent[]>(person.id, '/v1/agents'),
    ]);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const out: AgentView[] = [];
    const copyIds = new Set<string>();
    const fallbackModel = await this.defaultModel(person.id, settings);
    let catalog: PlatformTemplate[] | null = null;

    for (const spec of provided) {
      const modelId = (await this.resolveModel(person.id, spec.modelId)) ?? fallbackModel;
      let agent = byId.get(copies.get(spec.id) ?? '');
      if (!agent) {
        catalog ??= await this.templates(person.id);
        const template = spec.templateId
          ? catalog.find((candidate) => candidate.id === spec.templateId)
          : this.settings.defaultTemplateSlug
            ? catalog.find((candidate) => candidate.slug === this.settings.defaultTemplateSlug)
            : undefined;
        if (spec.templateId && !template) {
          console.warn(
            `[agents] provided agent "${spec.name}" uses a template that isn't in the platform's catalog; personal workspaces can't deploy it`,
          );
          continue;
        }
        agent = await this.json<PlatformAgent>(
          person.id,
          `/v1/teams/${encodeURIComponent(team.slug)}/agents`,
          {
            method: 'POST',
            body: JSON.stringify({
              name: spec.name,
              description: spec.description,
              ...(template ? { templateId: template.id } : {}),
              ...(modelId ? { modelId } : {}),
            }),
          },
        );
        await this.store.setProvidedCopy(person.id, spec.id, agent.id);
      } else if (modelId && agent.model?.id !== modelId) {
        try {
          agent = await this.patch(person.id, agent, { modelId });
        } catch (error) {
          console.warn(`[agents] could not move "${spec.name}" to its model`, error);
        }
      }
      copyIds.add(agent.id);
      out.push({ ...agent, name: spec.name, description: spec.description, kind: 'provided' });
    }

    for (const agent of agents) {
      if (copyIds.has(agent.id)) continue;
      if (agent.teamId === team.id) out.push({ ...agent, kind: 'personal' });
    }
    for (const agent of agents) {
      if (copyIds.has(agent.id) || agent.teamId === team.id) continue;
      out.push({
        ...agent,
        kind: 'team',
        teamName: String(agent.teamName ?? agent.teamSlug ?? ''),
      });
    }
    return out;
  }

  /** What the person may make agents from, and how many more they may make. */
  async catalog(person: Person) {
    const settings = await this.settings.agentSettings();
    const [templates, models, agents] = await Promise.all([
      this.allowedTemplates(person.id, settings),
      settings.allowModelChoice ? this.models(person.id) : Promise.resolve([]),
      this.list(person),
    ]);
    return {
      templates: templates.map(({ id, name, description }) => ({
        id,
        name,
        description: description ?? '',
      })),
      models: models.map(({ id, name }) => ({ id, name })),
      defaultModelId: await this.defaultModel(person.id, settings),
      allowModelChoice: settings.allowModelChoice,
      limit: settings.personalLimit,
      used: agents.filter((agent) => agent.kind === 'personal').length,
    };
  }

  async create(person: Person, body: { name?: unknown; templateId?: unknown; modelId?: unknown }) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60)
      throw new AgentProblem(400, 'invalid_name', 'Give the agent a name of 1 to 60 characters.');
    const settings = await this.settings.agentSettings();
    const agents = await this.list(person);
    const used = agents.filter((agent) => agent.kind === 'personal').length;
    if (used >= settings.personalLimit)
      throw new AgentProblem(
        409,
        'limit',
        settings.personalLimit === 0
          ? 'Making agents is turned off. Ask an administrator.'
          : `You can have up to ${settings.personalLimit} agents of your own. Delete one to make another.`,
      );
    const team = await this.personal(person.id);
    const limits = await this.json<{ maxAgents?: number | null; agentCount: number }>(
      person.id,
      `/v1/teams/${encodeURIComponent(team.slug)}/limits`,
    ).catch(() => null);
    if (limits?.maxAgents != null && limits.agentCount >= limits.maxAgents)
      throw new AgentProblem(
        409,
        'limit',
        `Your personal workspace on the agent platform holds up to ${limits.maxAgents} agents. Delete one to make another.`,
      );
    const template = (await this.allowedTemplates(person.id, settings)).find(
      (candidate) => candidate.id === body.templateId,
    );
    if (!template)
      throw new AgentProblem(400, 'invalid_template', 'Choose one of the templates offered.');
    let modelId = await this.defaultModel(person.id, settings);
    if (settings.allowModelChoice && typeof body.modelId === 'string' && body.modelId) {
      modelId = await this.resolveModel(person.id, body.modelId);
      if (!modelId)
        throw new AgentProblem(400, 'invalid_model', 'Choose one of the models offered.');
    }
    const agent = await this.json<PlatformAgent>(
      person.id,
      `/v1/teams/${encodeURIComponent(team.slug)}/agents`,
      {
        method: 'POST',
        body: JSON.stringify({ name, templateId: template.id, ...(modelId ? { modelId } : {}) }),
      },
    );
    return { ...agent, kind: 'personal' as const };
  }

  /** One of the person's own agents (in their personal workspace, not a provided copy). */
  private async ownAgent(person: Person, agentId: string): Promise<PlatformAgent> {
    const [team, copies] = await Promise.all([
      this.personal(person.id),
      this.store.providedCopies(person.id),
    ]);
    if ([...copies.values()].includes(agentId))
      throw new AgentProblem(404, 'not_found', 'Agent not found');
    const agent = await this.json<PlatformAgent>(
      person.id,
      `/v1/agents/${encodeURIComponent(agentId)}`,
    ).catch((error) => {
      if (error instanceof PlatformError && (error.status === 404 || error.status === 403))
        throw new AgentProblem(404, 'not_found', 'Agent not found');
      throw error;
    });
    if (agent.teamId !== team.id) throw new AgentProblem(404, 'not_found', 'Agent not found');
    return agent;
  }

  async update(person: Person, agentId: string, body: { name?: unknown; modelId?: unknown }) {
    const agent = await this.ownAgent(person, agentId);
    const settings = await this.settings.agentSettings();
    const change: { name?: string; modelId?: string } = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 60)
        throw new AgentProblem(400, 'invalid_name', 'A name of 1 to 60 characters.');
      change.name = name;
    }
    if (body.modelId !== undefined) {
      if (!settings.allowModelChoice)
        throw new AgentProblem(403, 'model_fixed', 'Your administrator chooses the model.');
      const modelId = await this.resolveModel(
        person.id,
        typeof body.modelId === 'string' ? body.modelId : null,
      );
      if (!modelId)
        throw new AgentProblem(400, 'invalid_model', 'Choose one of the models offered.');
      change.modelId = modelId;
    }
    const updated = Object.keys(change).length ? await this.patch(person.id, agent, change) : agent;
    return { ...updated, kind: 'personal' as const };
  }

  async remove(person: Person, agentId: string) {
    const agent = await this.ownAgent(person, agentId);
    await this.json(person.id, `/v1/agents/${encodeURIComponent(agent.id)}`, {
      method: 'DELETE',
    }).catch((error) => {
      if (!(error instanceof PlatformError && error.status === 404)) throw error;
    });
  }

  /** The person's own usage: their personal workspace's report, per agent and per day. */
  async usage(
    person: Person,
    groupBy: 'agent' | 'day',
    from: string,
    to: string,
    agentId?: string,
  ) {
    const team = await this.personal(person.id);
    const query = new URLSearchParams({ groupBy, from, to, ...(agentId ? { agentId } : {}) });
    return (
      await this.json<{ rows: import('./usage.ts').PlatformUsageRow[] }>(
        person.id,
        `/v1/teams/${encodeURIComponent(team.slug)}/usage?${query}`,
      )
    ).rows;
  }
}
