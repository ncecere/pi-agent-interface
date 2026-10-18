import { Check } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '~/api/client';
import { AdminHeader } from '~/components/admin/admin-layout';
import { Wordmark } from '~/components/brand/wordmark';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { type Branding, useBranding, useSaveBranding } from '~/hooks/use-admin';
import { usePageTitle } from '~/lib/document-title';
import { cn } from '~/lib/utils';

const ACCENTS: { value: Branding['colorTheme']; label: string; swatch: string }[] = [
  { value: 'neutral', label: 'Neutral', swatch: 'oklch(0.75 0 0)' },
  { value: 'blue', label: 'Blue', swatch: 'oklch(0.62 0.19 259)' },
  { value: 'violet', label: 'Violet', swatch: 'oklch(0.6 0.22 293)' },
  { value: 'emerald', label: 'Emerald', swatch: 'oklch(0.6 0.15 163)' },
];
const THEMES: { value: Branding['defaultTheme']; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const INPUT =
  'h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm placeholder:text-[var(--text-muted)] aria-[invalid=true]:border-[var(--danger)]';

export function AdminBrandingPage() {
  usePageTitle('Branding · Admin');
  const saved = useBranding();
  const save = useSaveBranding();
  const [draft, setDraft] = useState<Branding | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const id = useId();
  useEffect(() => {
    if (saved.data && !draft) setDraft(saved.data);
  }, [saved.data, draft]);

  if (!draft)
    return (
      <div className="py-16">
        <Spinner className="mx-auto" />
      </div>
    );
  const changed = JSON.stringify(draft) !== JSON.stringify(saved.data);
  const set = (patch: Partial<Branding>) => setDraft({ ...draft, ...patch });

  const submit = () =>
    save.mutate(
      { ...draft, logoUrl: draft.logoUrl?.trim() || null },
      {
        onSuccess: (branding) => {
          setDraft(branding);
          setProblems({});
          toast('Branding saved.');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.details)
            setProblems(error.details as Record<string, string>);
          toast.error(errorMessage(error, 'Branding was not saved.'));
        },
      },
    );

  return (
    <>
      <AdminHeader
        title="Branding"
        description="How this instance presents itself, on every page and the sign-in page. People start with this look and can change their own in Settings."
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={!changed || save.isPending}
              onClick={() => saved.data && setDraft(saved.data)}
            >
              Discard
            </Button>
            <Button variant="primary" disabled={!changed || save.isPending} onClick={submit}>
              {save.isPending && <Spinner className="size-4" />}
              Save
            </Button>
          </div>
        }
      />

      <div className="mb-10 flex items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-5 py-4">
        <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Preview
        </span>
        <Wordmark name={draft.name} logoUrl={draft.logoUrl?.trim() || null} />
      </div>

      <SettingsSection title="Identity" first>
        <SettingsRow
          id={`${id}-name`}
          label="Name"
          description="Shown in the sidebar, the sign-in page and page titles."
        >
          <div className="w-72">
            <input
              id={`${id}-name`}
              aria-labelledby={`${id}-name-label`}
              aria-invalid={Boolean(problems.name)}
              maxLength={60}
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              className={INPUT}
            />
            {problems.name && (
              <p className="mt-1 text-xs text-[var(--danger-on-tint)]">{problems.name}</p>
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          id={`${id}-logo`}
          label="Logo"
          description="An https address, or a path on this site. Leave empty for the built-in mark. It replaces the name where both would show."
        >
          <div className="w-72">
            <input
              aria-labelledby={`${id}-logo-label`}
              aria-invalid={Boolean(problems.logoUrl)}
              placeholder="https://example.com/logo.svg"
              value={draft.logoUrl ?? ''}
              onChange={(event) => set({ logoUrl: event.target.value })}
              className={INPUT}
            />
            {problems.logoUrl && (
              <p className="mt-1 text-xs text-[var(--danger-on-tint)]">{problems.logoUrl}</p>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Default look">
        <SettingsRow
          id={`${id}-accent`}
          label="Accent"
          description="Buttons, links and highlights."
        >
          <div role="radiogroup" aria-labelledby={`${id}-accent-label`} className="flex gap-2">
            {ACCENTS.map((accent) => (
              <label
                key={accent.value}
                title={accent.label}
                className="relative flex size-9 cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent-bright)]"
                style={{ background: accent.swatch }}
              >
                <input
                  type="radio"
                  name={`${id}-accent`}
                  aria-label={accent.label}
                  checked={draft.colorTheme === accent.value}
                  onChange={() => set({ colorTheme: accent.value })}
                  className="sr-only"
                />
                {draft.colorTheme === accent.value && (
                  <Check className="size-4 text-white drop-shadow" aria-hidden="true" />
                )}
              </label>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          id={`${id}-theme`}
          label="Appearance"
          description="Light, dark, or each person's device setting."
        >
          <div
            role="radiogroup"
            aria-labelledby={`${id}-theme-label`}
            className="inline-flex gap-1 rounded-xl bg-[var(--bg-segment-track)] p-1"
          >
            {THEMES.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'cursor-pointer rounded-lg px-3 py-1.5 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--accent-bright)]',
                  draft.defaultTheme === option.value
                    ? 'bg-[var(--bg-segment-active)] font-medium text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-theme`}
                  checked={draft.defaultTheme === option.value}
                  onChange={() => set({ defaultTheme: option.value })}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
