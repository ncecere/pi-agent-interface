import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, LifeBuoy, ShieldCheck } from 'lucide-react';
import { errorMessage } from '~/api/client';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { ME_KEY, nextPath, useAuthConfig, useDevSignIn } from '~/hooks/use-session';
import { usePageTitle } from '~/lib/document-title';
import { instanceName } from '~/shared';

const SIGN_IN_ERRORS: Record<string, string> = {
  expired: 'Signing in took too long. Try again.',
  failed: "Single sign-on didn't complete. Try again, or ask an administrator.",
};

/**
 * Sign in to this app: single sign-on (OIDC) when it is configured, and the
 * development accounts when DEV_AUTH is on. People never sign in to the agent
 * platform; this app's server talks to it for them.
 */
export function SignInPage() {
  const config = useAuthConfig();
  const devSignIn = useDevSignIn();
  const queryClient = useQueryClient();
  usePageTitle('Sign in');
  const instance = config.data?.instance;
  const appName = instance?.name;
  const returnTo = nextPath(window.location.search) ?? '/';
  const params = new URLSearchParams(window.location.search);
  const signedOut = params.has('signed-out');
  const failure = SIGN_IN_ERRORS[params.get('error') ?? ''];

  return (
    <main className="flex min-h-dvh flex-col items-center px-4 pt-[12vh] pb-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <h1 className="sr-only">Sign in to {instanceName(appName)}</h1>
          <Wordmark name={appName} logoUrl={instance?.logoUrl} className="text-2xl" />
          <p className="text-sm text-[var(--text-muted)]">
            Sign in{instance?.orgName ? ` with your ${instance.orgName} account` : ''} to talk to
            your agents.
          </p>
        </div>

        {config.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-5" />
          </div>
        ) : config.isError ? (
          <p
            role="alert"
            className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
          >
            The chat server could not be reached. {errorMessage(config.error, '')} Reload to try
            again.
          </p>
        ) : (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-6 backdrop-blur-sm">
            {failure && (
              <p
                role="alert"
                className="mb-4 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
              >
                {failure}
              </p>
            )}
            {signedOut && !failure && (
              <p
                role="status"
                className="mb-4 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-secondary)]"
              >
                Your session ended. Sign in again to continue.
              </p>
            )}
            {config.data.oidcEnabled && (
              <Button asChild variant="primary" className="w-full">
                <a href={`/auth/login?next=${encodeURIComponent(returnTo)}`}>
                  <ShieldCheck />
                  Sign in with single sign-on
                </a>
              </Button>
            )}

            {config.data.oidcEnabled && config.data.devAuthEnabled && (
              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                <span className="text-[0.6875rem] uppercase tracking-wider text-[var(--text-muted)]">
                  or
                </span>
                <span className="h-px flex-1 bg-[var(--border-subtle)]" />
              </div>
            )}

            {config.data.devAuthEnabled && (
              <section aria-labelledby="dev-accounts">
                <h2 id="dev-accounts" className="text-sm font-medium text-[var(--text-primary)]">
                  Development accounts
                </h2>
                <p className="mt-0.5 mb-3 text-xs text-[var(--text-muted)]">
                  Local development only. These accounts have no password.
                </p>
                <ul className="flex flex-col gap-1.5">
                  {config.data.devAccounts.map((account) => {
                    const busy = devSignIn.isPending && devSignIn.variables === account.id;
                    return (
                      <li key={account.id}>
                        <button
                          type="button"
                          disabled={devSignIn.isPending}
                          aria-busy={busy || undefined}
                          onClick={() =>
                            devSignIn.mutate(account.id, {
                              onSuccess: async () => {
                                await queryClient.invalidateQueries({ queryKey: ME_KEY });
                                window.location.assign(returnTo);
                              },
                            })
                          }
                          className="flex w-full items-center gap-3 rounded-xl border border-[var(--border-subtle)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-control-hover)] disabled:opacity-60"
                        >
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-[var(--accent-foreground)]">
                            {account.name
                              .split(/\s+/)
                              .map((part) => part[0])
                              .slice(0, 2)
                              .join('')
                              .toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                              {account.name}
                            </span>
                            <span className="block truncate text-xs text-[var(--text-muted)]">
                              {account.email}
                            </span>
                          </span>
                          {busy ? (
                            <Spinner className="size-4" />
                          ) : (
                            <ArrowRight className="size-4 text-[var(--text-muted)]" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {devSignIn.error && (
                  <p role="alert" className="mt-3 text-xs text-[var(--danger-on-tint)]">
                    {errorMessage(devSignIn.error)}
                  </p>
                )}
              </section>
            )}

            {!config.data.oidcEnabled && !config.data.devAuthEnabled && (
              <p className="text-sm text-[var(--warning)]">
                No sign-in method is configured. Set OIDC_* (or DEV_AUTH=true locally) for the
                server.
              </p>
            )}
          </div>
        )}

        {instance?.supportUrl && (
          <p className="mt-6 text-center text-xs">
            <a
              href={instance.supportUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <LifeBuoy className="size-3.5" /> Help signing in
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
