import { LogOut, Users } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { useCurrentUser, useSignOut } from '~/hooks/use-session';
import { cn } from '~/lib/utils';

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const me = useCurrentUser();
  const signOut = useSignOut();
  if (!me) return null;

  const { user, teams } = me;
  const name = user.displayName || user.email;
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const role =
    user.platformRole === 'platform_admin'
      ? 'Platform admin'
      : user.platformRole === 'platform_auditor'
        ? 'Platform auditor'
        : teams.length === 1
          ? teams[0]!.name
          : `${teams.length} teams`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={compact ? 'Open user menu' : undefined}
        className={cn(
          'flex items-center gap-3 rounded-lg text-left transition-colors hover:bg-[var(--bg-control)]',
          compact ? 'rounded-full p-1' : 'w-full px-2 py-2',
        )}
      >
        <span
          className={cn(
            'flex items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-[var(--accent-foreground)]',
            compact ? 'size-10' : 'size-8',
          )}
        >
          {initials}
        </span>
        <span className={cn('min-w-0 flex-1', compact && 'hidden')}>
          <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
            {name}
          </span>
          <span className="block truncate text-xs text-[var(--text-muted)]">{role}</span>
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="truncate font-normal text-[var(--text-muted)]">
          {user.email}
        </DropdownMenuLabel>
        {teams.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2">
              <Users className="size-3.5" aria-hidden="true" /> Teams
            </DropdownMenuLabel>
            {teams.map((team) => (
              <DropdownMenuItem key={team.id} disabled className="justify-between opacity-100">
                <span className="truncate">{team.name}</span>
                <span className="text-xs capitalize text-[var(--text-muted)]">{team.role}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut.mutate()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
