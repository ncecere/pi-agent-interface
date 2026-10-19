import { Ellipsis, Search, ShieldCheck, ShieldOff, UserCheck, UserX } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '~/api/client';
import { AdminHeader, timeAgo } from '~/components/admin/admin-layout';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { type AdminPerson, usePeople, useUpdatePerson } from '~/hooks/use-admin';
import { useCurrentUser } from '~/hooks/use-session';
import { usePageTitle } from '~/lib/document-title';
import { cn } from '~/lib/utils';

function Pill({ children, tone }: { children: string; tone: 'accent' | 'muted' | 'danger' }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold',
        tone === 'accent' && 'bg-[var(--accent-soft)] text-[var(--text-primary)]',
        tone === 'muted' && 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
        tone === 'danger' && 'bg-[var(--danger)]/15 text-[var(--danger-on-tint)]',
      )}
    >
      {children}
    </span>
  );
}

export function AdminPeoplePage() {
  usePageTitle('People · Admin');
  const me = useCurrentUser();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const people = usePeople(deferred);
  const update = useUpdatePerson();
  const [suspending, setSuspending] = useState<AdminPerson | null>(null);

  const change = (
    person: AdminPerson,
    patch: { role?: AdminPerson['role']; status?: AdminPerson['status'] },
    done: string,
  ) =>
    update.mutate(
      { id: person.id, ...patch },
      {
        onSuccess: () => toast(done),
        onError: (error) => toast.error(errorMessage(error, 'The change was not saved.')),
      },
    );

  const name = (person: AdminPerson) => person.name || person.email;

  return (
    <>
      <AdminHeader
        title="People"
        description="Everyone who has signed in. Administrators manage this dashboard; suspended people can't sign in, and their sessions end at once."
      />

      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or email"
          aria-label="Search people"
          className="h-10 w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)] pr-3 pl-9 text-sm placeholder:text-[var(--text-muted)]"
        />
      </div>

      {!people.data ? (
        <div className="py-16">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-2.5 font-medium">Person</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Last seen</th>
                <th className="w-12 px-2 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {people.data.map((person) => {
                const self = person.id === me?.user.id;
                return (
                  <tr key={person.id}>
                    <td className="max-w-[18rem] px-4 py-3">
                      <span className="block truncate font-medium text-[var(--text-primary)]">
                        {name(person)}
                        {self && (
                          <span className="font-normal text-[var(--text-muted)]"> (you)</span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-[var(--text-muted)]">
                        {person.email}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={person.role === 'admin' ? 'accent' : 'muted'}>
                        {person.role === 'admin' ? 'Administrator' : 'Member'}
                      </Pill>
                      {person.roleManaged && (
                        <span className="mt-1 block text-[0.6875rem] text-[var(--text-muted)]">
                          Set by sign-in group
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={person.status === 'suspended' ? 'danger' : 'muted'}>
                        {person.status === 'suspended' ? 'Suspended' : 'Active'}
                      </Pill>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {timeAgo(person.lastSeenAt)}
                    </td>
                    <td className="px-2 py-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${name(person)}`}
                          >
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          {!person.roleManaged &&
                            (person.role === 'admin' ? (
                              <DropdownMenuItem
                                onSelect={() =>
                                  change(
                                    person,
                                    { role: 'user' },
                                    `${name(person)} is now a member.`,
                                  )
                                }
                              >
                                <ShieldOff />
                                Make member
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onSelect={() =>
                                  change(
                                    person,
                                    { role: 'admin' },
                                    `${name(person)} is now an administrator.`,
                                  )
                                }
                              >
                                <ShieldCheck />
                                Make administrator
                              </DropdownMenuItem>
                            ))}
                          {person.status === 'suspended' ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                change(person, { status: 'active' }, `${name(person)} is restored.`)
                              }
                            >
                              <UserCheck />
                              Restore
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={self}
                              onSelect={() => setSuspending(person)}
                            >
                              <UserX />
                              Suspend…
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
              {people.data.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-[var(--text-muted)]"
                  >
                    {search ? 'No one matches.' : 'No one has signed in yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={suspending !== null} onOpenChange={(open) => !open && setSuspending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend {suspending ? name(suspending) : ''}?</DialogTitle>
            <DialogDescription>
              They're signed out everywhere at once and can't sign in again until restored. Their
              agents and conversations are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setSuspending(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (suspending)
                  change(suspending, { status: 'suspended' }, `${name(suspending)} is suspended.`);
                setSuspending(null);
              }}
            >
              Suspend
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
