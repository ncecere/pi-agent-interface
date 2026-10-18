import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Link2, ShieldCheck } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { onNotConnected } from '~/api/client';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { ME_KEY, useAuthConfig, useCurrentUser, useSignOut } from '~/hooks/use-session';
import { usePageTitle } from '~/lib/document-title';
import { instanceName } from '~/shared';

/** Where the server's Connect flow starts; it comes back to `next`. */
export const connectHref = (next = window.location.pathname + window.location.search) =>
  `/connect/start?next=${encodeURIComponent(next.startsWith('/connect') ? '/' : next)}`;

/**
 * Connect mode (server/connect.ts): until the person has connected their own
 * account on the agent platform, the app shows only this. Any request the
 * server answers with `not_connected` (they disconnected the app on the
 * platform, or an administrator revoked it) brings it back.
 */
export function ConnectGate({ children }: { children: ReactNode }) {
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  useEffect(
    () => onNotConnected(() => void queryClient.invalidateQueries({ queryKey: ME_KEY })),
    [queryClient],
  );
  const needsConnect = me?.platform?.mode === 'connect' && !me.platform.account;
  const onConnectPage = window.location.pathname === '/connect';
  if (needsConnect || onConnectPage) return <ConnectPage />;
  return <>{children}</>;
}

const errorOf = () => new URLSearchParams(window.location.search).get('error');

export function ConnectPage() {
  usePageTitle('Connect your agents');
  const config = useAuthConfig();
  const me = useCurrentUser();
  const signOut = useSignOut();
  const appName = instanceName(config.data?.instance.name);
  const error = errorOf();
  const connected = Boolean(me?.platform?.account);

  return (
    <main className="flex min-h-dvh flex-col items-center px-4 pt-[12vh] pb-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Wordmark name={config.data?.instance.name} logoUrl={config.data?.instance.logoUrl} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Connect your agents</h1>
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            {appName} uses your account on the agent platform for your agents and conversations. You
            sign in there once and allow {appName} to use it; your agents stay in your own
            workspace.
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="mb-4 rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
          >
            {error}
          </p>
        )}

        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5">
          <ul className="space-y-3 text-sm text-[var(--text-secondary)]">
            <li className="flex gap-3">
              <Link2
                className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              Your agents live in your personal workspace on the platform, with your teams' agents
              beside them.
            </li>
            <li className="flex gap-3">
              <ShieldCheck
                className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              {appName} acts only on your agents, as you. You can disconnect it at any time, here or
              in the platform's Connected apps.
            </li>
          </ul>
          {connected ? (
            <Button asChild className="mt-5 w-full">
              <a href="/">
                Continue
                <ArrowRight aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <Button asChild className="mt-5 w-full">
              <a href={connectHref('/')}>
                Connect
                <ArrowRight aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>

        {me && (
          <p className="mt-6 text-center text-sm text-[var(--text-muted)]">
            Signed in as {me.user.email || me.user.name}.{' '}
            <button type="button" className="underline" onClick={() => signOut.mutate()}>
              Sign out
            </button>
          </p>
        )}
      </div>
    </main>
  );
}
