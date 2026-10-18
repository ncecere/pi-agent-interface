import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, MonitorSmartphone, Unplug } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, type Me } from '~/api/client';
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
import { ME_KEY, useCurrentUser, useSignOut } from '~/hooks/use-session';
import { usePageTitle } from '~/lib/document-title';

/** Connect mode: whose platform account this app uses for the person's agents, and a way out. */
function PlatformConnection({ account }: { account: NonNullable<Me['platform']>['account'] }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => api.post('/api/me/platform/disconnect'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ME_KEY }),
  });
  return (
    <SettingsSection title="Agent platform">
      <SettingsRow
        id="platform"
        label="Connected account"
        description={
          account
            ? 'Your agents and conversations are on the agent platform, in this account.'
            : 'Not connected.'
        }
      >
        <Value>{account ? (account.email ?? account.name ?? 'Connected') : '—'}</Value>
      </SettingsRow>
      <SettingsRow
        id="disconnect"
        label="Disconnect"
        description="This app stops using your platform account until you connect again. Your agents and conversations stay on the platform."
      >
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          <Unplug aria-hidden="true" />
          Disconnect
        </Button>
      </SettingsRow>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect from the agent platform?</DialogTitle>
            <DialogDescription>
              You'll be asked to connect again before you can talk to your agents. Nothing is
              deleted.
            </DialogDescription>
          </DialogHeader>
          {disconnect.isError && (
            <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
              {errorMessage(disconnect.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function Value({ children }: { children: string }) {
  return <p className="text-sm text-[var(--text-primary)] sm:text-right">{children}</p>;
}

export function SettingsAccountPage() {
  usePageTitle('Account · Settings');
  const me = useCurrentUser();
  const signOut = useSignOut();
  const [confirming, setConfirming] = useState(false);
  const everywhere = useMutation({
    mutationFn: () => api.post('/api/me/sign-out-everywhere'),
    onSuccess: () => window.location.assign('/sign-in'),
  });
  if (!me) return null;
  const { user } = me;

  return (
    <>
      <SettingsSection title="Profile" first>
        <SettingsRow
          id="name"
          label="Name"
          description="From your organization's sign-in. Change it there; it updates here the next time you sign in."
        >
          <Value>{user.name || '—'}</Value>
        </SettingsRow>
        <SettingsRow id="email" label="Email" description="Also from your organization's sign-in.">
          <Value>{user.email || '—'}</Value>
        </SettingsRow>
        <SettingsRow
          id="role"
          label="Role"
          description={
            user.role === 'admin'
              ? 'You can manage people, branding and agents in the admin dashboard.'
              : 'Your administrator decides roles.'
          }
        >
          <Value>{user.role === 'admin' ? 'Administrator' : 'Member'}</Value>
        </SettingsRow>
      </SettingsSection>

      {me.platform?.mode === 'connect' && <PlatformConnection account={me.platform.account} />}

      <SettingsSection title="Sessions">
        <SettingsRow id="sign-out" label="Sign out" description="Sign out of this browser.">
          <Button variant="secondary" size="sm" onClick={() => signOut.mutate()}>
            <LogOut />
            Sign out
          </Button>
        </SettingsRow>
        <SettingsRow
          id="everywhere"
          label="Sign out everywhere"
          description="Sign out of every browser and device you have used, this one included. Use it if you signed in on a computer that isn't yours."
        >
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            <MonitorSmartphone />
            Sign out everywhere
          </Button>
        </SettingsRow>
      </SettingsSection>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out everywhere?</DialogTitle>
            <DialogDescription>
              Every browser and device you're signed in on will need to sign in again, this one
              included. Your conversations and settings are kept.
            </DialogDescription>
          </DialogHeader>
          {everywhere.error && (
            <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
              {errorMessage(everywhere.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={everywhere.isPending}
              onClick={() => everywhere.mutate()}
            >
              Sign out everywhere
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
