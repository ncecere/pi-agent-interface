import { toast } from 'sonner';
import { errorMessage } from '~/api/client';
import { AdminHeader } from '~/components/admin/admin-layout';
import { SettingsRow } from '~/components/settings/settings-layout';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { useFeaturesAdmin, useSaveFeatures } from '~/hooks/use-admin';
import { usePageTitle } from '~/lib/document-title';

/**
 * Optional features (server/features.ts): whole parts of the app this
 * instance may do without. Each switch saves at once and is in the audit log.
 */
export function AdminFeaturesPage() {
  usePageTitle('Features · Admin');
  const features = useFeaturesAdmin();
  const save = useSaveFeatures();

  return (
    <>
      <AdminHeader
        title="Features"
        description="Parts of the app this instance can do without. Turning one off hides it for everyone; its data stays where it is."
      />
      {!features.data ? (
        <div className="py-16">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <div className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          {features.data.map((feature) => (
            <div key={feature.id} className="px-5 py-4">
              <SettingsRow
                id={`feature-${feature.id}`}
                label={feature.label}
                description={
                  <>
                    {feature.description}
                    <span className="mt-1 block text-xs">
                      {feature.locked
                        ? 'Turned off by this deployment (DISABLED_FEATURES), so it cannot be turned on here.'
                        : `${feature.default ? 'On' : 'Off'} unless changed here.`}
                    </span>
                  </>
                }
              >
                <Switch
                  checked={feature.enabled}
                  disabled={feature.locked || save.isPending}
                  aria-labelledby={`feature-${feature.id}-label`}
                  aria-describedby={`feature-${feature.id}-description`}
                  onCheckedChange={(enabled) =>
                    save.mutate(
                      { [feature.id]: enabled },
                      {
                        onSuccess: () =>
                          toast.success(`${feature.label} is ${enabled ? 'on' : 'off'}.`),
                        onError: (error) => toast.error(errorMessage(error)),
                      },
                    )
                  }
                />
              </SettingsRow>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
