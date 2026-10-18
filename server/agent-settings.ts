/**
 * How agents work in this app, set by administrators (Admin → Agents):
 *
 * - **settings**: the default model, how many agents each person may make
 *   themselves, whether they may choose the model, and the templates allowed.
 * - **provided**: agents everyone gets, each person their own copy (private
 *   conversations). The first is the built-in assistant, whose platform key is
 *   `u:<person>` (the key the app has always used); the others are
 *   `u:<person>:m:<id>`. A person's own agents are `u:<person>:p:<slot>`.
 */

export interface AgentSettings {
  /** A model id published to the team, or null: the platform's (or AGENT_MODEL's) default. */
  defaultModelId: string | null;
  /** How many agents each person may make themselves; 0 turns making agents off. */
  personalLimit: number;
  allowModelChoice: boolean;
  /** Template ids people may make agents from; null: every template the team may use. */
  allowedTemplateIds: string[] | null;
}

export interface ProvidedAgent {
  /** `assistant` for the built-in one, otherwise a short random id. */
  id: string;
  name: string;
  description: string;
  /** Null: the AGENT_TEMPLATE (or the platform's default) template. */
  templateId: string | null;
  /** Null: the default model. */
  modelId: string | null;
}

export const ASSISTANT_ID = 'assistant';
export const MAX_PERSONAL_LIMIT = 50;
export const MAX_PROVIDED = 20;

export const defaultAgentSettings = (): AgentSettings => ({
  defaultModelId: null,
  personalLimit: 5,
  allowModelChoice: true,
  allowedTemplateIds: null,
});

export const defaultProvided = (assistantName: string): ProvidedAgent[] => [
  { id: ASSISTANT_ID, name: assistantName, description: '', templateId: null, modelId: null },
];

/** The platform key of a person's agent of each kind. */
export const keys = {
  provided: (personId: string, id: string) =>
    id === ASSISTANT_ID ? `u:${personId}` : `u:${personId}:m:${id}`,
  personal: (personId: string, slot: string) => `u:${personId}:p:${slot}`,
};

/** Which of the person's agents a key is, or null if it is not theirs. */
export function kindOfKey(
  personId: string,
  key: string | null | undefined,
): { kind: 'provided'; id: string } | { kind: 'personal'; slot: string } | null {
  if (!key) return null;
  const own = `u:${personId}`;
  if (key === own) return { kind: 'provided', id: ASSISTANT_ID };
  if (key.startsWith(`${own}:m:`)) return { kind: 'provided', id: key.slice(own.length + 3) };
  if (key.startsWith(`${own}:p:`)) return { kind: 'personal', slot: key.slice(own.length + 3) };
  return null;
}

type Problems = Record<string, string>;
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);

/** Validates agent settings against what the platform offers. */
export function parseAgentSettings(
  input: unknown,
  offered: { modelIds: Set<string>; templateIds: Set<string> },
): { value: AgentSettings } | { problems: Problems } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const problems: Problems = {};
  const defaultModelId =
    raw.defaultModelId === null || raw.defaultModelId === '' ? null : raw.defaultModelId;
  if (defaultModelId !== null && !(isId(defaultModelId) && offered.modelIds.has(defaultModelId)))
    problems.defaultModelId = 'Choose a model published to the team.';
  const limit = Number(raw.personalLimit);
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PERSONAL_LIMIT)
    problems.personalLimit = `A whole number from 0 to ${MAX_PERSONAL_LIMIT}.`;
  if (typeof raw.allowModelChoice !== 'boolean') problems.allowModelChoice = 'On or off.';
  let allowed: string[] | null = null;
  if (raw.allowedTemplateIds !== null && raw.allowedTemplateIds !== undefined) {
    if (
      !Array.isArray(raw.allowedTemplateIds) ||
      !raw.allowedTemplateIds.every((id) => isId(id) && offered.templateIds.has(id))
    )
      problems.allowedTemplateIds = 'Choose templates the team may use.';
    else allowed = [...new Set(raw.allowedTemplateIds as string[])];
  }
  if (Object.keys(problems).length) return { problems };
  return {
    value: {
      defaultModelId: defaultModelId as string | null,
      personalLimit: limit,
      allowModelChoice: raw.allowModelChoice as boolean,
      allowedTemplateIds: allowed,
    },
  };
}

/** Validates the provided agents. The built-in assistant may be renamed or changed, not removed. */
export function parseProvided(
  input: unknown,
  offered: { modelIds: Set<string>; templateIds: Set<string> },
): { value: ProvidedAgent[] } | { problems: Problems } {
  const list = Array.isArray((input as { agents?: unknown })?.agents)
    ? (input as { agents: unknown[] }).agents
    : null;
  if (!list) return { problems: { agents: 'Send the list of agents.' } };
  const problems: Problems = {};
  if (list.length > MAX_PROVIDED) problems.agents = `At most ${MAX_PROVIDED} provided agents.`;
  const seen = new Set<string>();
  const value: ProvidedAgent[] = [];
  list.forEach((item, index) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const at = (field: string) => `${index}.${field}`;
    if (!isId(raw.id) || seen.has(raw.id)) problems[at('id')] = 'Each agent needs its own id.';
    else seen.add(raw.id);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > 60) problems[at('name')] = 'A name of 1 to 60 characters.';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (description.length > 500) problems[at('description')] = 'At most 500 characters.';
    const templateId = raw.templateId ? raw.templateId : null;
    if (templateId !== null && !(isId(templateId) && offered.templateIds.has(templateId)))
      problems[at('templateId')] = 'Choose a template the team may use.';
    const modelId = raw.modelId ? raw.modelId : null;
    if (modelId !== null && !(isId(modelId) && offered.modelIds.has(modelId)))
      problems[at('modelId')] = 'Choose a model published to the team.';
    value.push({
      id: String(raw.id),
      name,
      description,
      templateId: templateId as string | null,
      modelId: modelId as string | null,
    });
  });
  if (!seen.has(ASSISTANT_ID))
    problems.agents = 'The built-in assistant can be changed but not removed.';
  if (Object.keys(problems).length) return { problems };
  return { value };
}
