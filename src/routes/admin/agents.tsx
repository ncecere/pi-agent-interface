import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '~/api/client';
import { AdminHeader } from '~/components/admin/admin-layout';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import {
  type AgentSettings,
  type AgentsAdmin,
  type ProvidedAgent,
  useAgentsAdmin,
  useSaveAgentSettings,
  useSaveProvided,
} from '~/hooks/use-admin';
import { usePageTitle } from '~/lib/document-title';

const FIELD =
  'h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm placeholder:text-[var(--text-muted)] aria-[invalid=true]:border-[var(--danger)]';

function ModelSelect({
  id,
  value,
  models,
  emptyLabel,
  onChange,
}: {
  id?: string;
  value: string | null;
  models: AgentsAdmin['models'];
  emptyLabel: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      className={FIELD}
    >
      <option value="">{emptyLabel}</option>
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name}
        </option>
      ))}
    </select>
  );
}

function SettingsForm({ data }: { data: AgentsAdmin }) {
  const save = useSaveAgentSettings();
  const [draft, setDraft] = useState<AgentSettings>(data.settings);
  useEffect(() => setDraft(data.settings), [data.settings]);
  const id = useId();
  const changed = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const allTemplates = draft.allowedTemplateIds === null;
  const toggleTemplate = (templateId: string) => {
    const current = new Set(
      draft.allowedTemplateIds ?? data.templates.map((template) => template.id),
    );
    if (current.has(templateId)) current.delete(templateId);
    else current.add(templateId);
    setDraft({ ...draft, allowedTemplateIds: [...current] });
  };
  const envModel = data.environmentModel;

  return (
    <SettingsSection title="Everyone's agents" first>
      <SettingsRow
        id={`${id}-model`}
        label="Default model"
        description={
          envModel
            ? `What agents run on unless chosen otherwise. Unset: AGENT_MODEL (${envModel}).`
            : "What agents run on unless chosen otherwise. Unset: the platform's default."
        }
      >
        <div className="w-64">
          <ModelSelect
            value={draft.defaultModelId}
            models={data.models}
            emptyLabel={envModel ? `AGENT_MODEL (${envModel})` : "Platform's default"}
            onChange={(defaultModelId) => setDraft({ ...draft, defaultModelId })}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        id={`${id}-limit`}
        label="Agents each person may make"
        description="Their own agents, besides the provided ones. 0 turns making agents off."
      >
        <input
          type="number"
          min={0}
          max={50}
          aria-labelledby={`${id}-limit-label`}
          value={draft.personalLimit}
          onChange={(event) =>
            setDraft({
              ...draft,
              personalLimit: Math.max(0, Math.min(50, Number(event.target.value) || 0)),
            })
          }
          className={`${FIELD} w-24`}
        />
      </SettingsRow>
      <SettingsRow
        id={`${id}-choice`}
        label="People choose the model"
        description="For agents they make. Off: those run on the default model."
      >
        <Switch
          checked={draft.allowModelChoice}
          onCheckedChange={(allowModelChoice) => setDraft({ ...draft, allowModelChoice })}
          aria-labelledby={`${id}-choice-label`}
        />
      </SettingsRow>
      <div>
        <p className="text-sm font-medium text-[var(--text-primary)]">
          Templates people may make agents from
        </p>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Templates come from the agent platform: its catalog, and your team's own.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allTemplates}
            onChange={() =>
              setDraft({
                ...draft,
                allowedTemplateIds: allTemplates ? data.templates.map((t) => t.id) : null,
              })
            }
            className="size-4 accent-[var(--accent)]"
          />
          Every template, including ones added later
        </label>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {data.templates.map((template) => (
            <li key={template.id}>
              <label className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  disabled={allTemplates}
                  checked={allTemplates || (draft.allowedTemplateIds ?? []).includes(template.id)}
                  onChange={() => toggleTemplate(template.id)}
                  className="mt-0.5 size-4 accent-[var(--accent)]"
                />
                <span className="min-w-0">
                  <span className="block font-medium">
                    {template.name}
                    {template.team && (
                      <span className="font-normal text-[var(--text-muted)]"> · your team</span>
                    )}
                  </span>
                  {template.description && (
                    <span className="block text-xs text-[var(--text-muted)]">
                      {template.description}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!changed || save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: () => toast('Agent settings saved.'),
              onError: (error) => toast.error(errorMessage(error, 'Not saved.')),
            })
          }
        >
          {save.isPending && <Spinner className="size-4" />}
          Save
        </Button>
        <Button variant="secondary" disabled={!changed} onClick={() => setDraft(data.settings)}>
          Discard
        </Button>
      </div>
    </SettingsSection>
  );
}

const newId = () => Math.random().toString(36).slice(2, 10);

function ProvidedEditor({
  agent,
  data,
  onClose,
  onSave,
  saving,
}: {
  agent: ProvidedAgent;
  data: AgentsAdmin;
  onClose: () => void;
  onSave: (agent: ProvidedAgent) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(agent);
  const id = useId();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{agent.name ? `Edit ${agent.name}` : 'New provided agent'}</DialogTitle>
          <DialogDescription>
            Everyone gets their own copy, so their conversations stay private. Changes reach each
            person's copy the next time they open the app; a new model applies from the agent's next
            start.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label htmlFor={`${id}-name`} className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <input
              id={`${id}-name`}
              maxLength={60}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="HR Helper"
              className={FIELD}
            />
          </label>
          <label
            htmlFor={`${id}-description`}
            className="flex flex-col gap-1.5 text-sm font-medium"
          >
            What it's for
            <input
              id={`${id}-description`}
              maxLength={500}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="Questions about benefits and leave"
              className={FIELD}
            />
          </label>
          <label htmlFor={`${id}-template`} className="flex flex-col gap-1.5 text-sm font-medium">
            Template
            <select
              id={`${id}-template`}
              value={draft.templateId ?? ''}
              onChange={(event) => setDraft({ ...draft, templateId: event.target.value || null })}
              className={FIELD}
            >
              <option value="">The default template</option>
              {data.templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-model`} className="flex flex-col gap-1.5 text-sm font-medium">
            Model
            <ModelSelect
              id={`${id}-model`}
              value={draft.modelId}
              models={data.models}
              emptyLabel="The default model"
              onChange={(modelId) => setDraft({ ...draft, modelId })}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!draft.name.trim() || saving}
            onClick={() => onSave(draft)}
          >
            {saving && <Spinner className="size-4" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProvidedList({ data }: { data: AgentsAdmin }) {
  const save = useSaveProvided();
  const [editing, setEditing] = useState<ProvidedAgent | null>(null);
  const names = new Map([...data.models, ...data.templates].map((item) => [item.id, item.name]));
  const persist = (agents: ProvidedAgent[], done: string) =>
    save.mutate(agents, {
      onSuccess: () => {
        toast(done);
        setEditing(null);
      },
      onError: (error) =>
        toast.error(
          error instanceof ApiError && error.details
            ? Object.values(error.details).join(' ')
            : errorMessage(error, 'Not saved.'),
        ),
    });

  return (
    <SettingsSection title="Provided agents">
      <p className="-mt-2 text-sm text-[var(--text-muted)]">
        Agents everyone gets. Each person has their own copy, with private conversations.
      </p>
      <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
        {data.provided.map((agent) => (
          <li key={agent.id} className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {agent.name}
                {agent.id === 'assistant' && (
                  <span className="font-normal text-[var(--text-muted)]"> · built in</span>
                )}
              </span>
              <span className="block truncate text-xs text-[var(--text-muted)]">
                {[
                  agent.description,
                  agent.templateId ? names.get(agent.templateId) : 'Default template',
                  agent.modelId ? names.get(agent.modelId) : 'Default model',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${agent.name}`}
              onClick={() => setEditing(agent)}
            >
              <Pencil />
            </Button>
            {agent.id !== 'assistant' && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${agent.name}`}
                onClick={() =>
                  persist(
                    data.provided.filter((each) => each.id !== agent.id),
                    `${agent.name} removed. People's existing copies stay on the platform until deleted there.`,
                  )
                }
              >
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div>
        <Button
          variant="secondary"
          disabled={data.provided.length >= 20}
          onClick={() =>
            setEditing({ id: newId(), name: '', description: '', templateId: null, modelId: null })
          }
        >
          <Plus />
          Add a provided agent
        </Button>
      </div>
      {editing && (
        <ProvidedEditor
          agent={editing}
          data={data}
          saving={save.isPending}
          onClose={() => setEditing(null)}
          onSave={(agent) => {
            const exists = data.provided.some((each) => each.id === agent.id);
            persist(
              exists
                ? data.provided.map((each) => (each.id === agent.id ? agent : each))
                : [...data.provided, agent],
              `${agent.name} saved.`,
            );
          }}
        />
      )}
    </SettingsSection>
  );
}

export function AdminAgentsPage() {
  usePageTitle('Agents · Admin');
  const { data, error } = useAgentsAdmin();
  return (
    <>
      <AdminHeader
        title="Agents"
        description="Which agents people have and what they run on. The agents live on the agent platform; models and templates are the ones it offers this app's team."
      />
      {error ? (
        <p
          role="alert"
          className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
        >
          {errorMessage(error, 'The agent platform could not be reached.')}
        </p>
      ) : !data ? (
        <div className="py-16">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <>
          <SettingsForm data={data} />
          <ProvidedList data={data} />
        </>
      )}
    </>
  );
}
