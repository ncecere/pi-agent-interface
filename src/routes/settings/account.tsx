import { useMutation } from '@tanstack/react-query';
import { LogOut, MonitorSmartphone } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '~/api/client';
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
import { useCurrentUser, useSignOut } from '~/hooks/use-session';
import { usePageTitle } from '~/lib/document-title';

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
