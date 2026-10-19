import { Link, Outlet, useLocation } from '@tanstack/react-router';
import {
  ArrowLeft,
  Bot,
  ChartColumn,
  LayoutDashboard,
  type LucideIcon,
  Palette,
  ScrollText,
  ToggleRight,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { FeatureId } from '~/api/client';
import { Wordmark } from '~/components/brand/wordmark';
import { SkipLink } from '~/components/layout/skip-link';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { useAuthConfig, useCurrentUser } from '~/hooks/use-session';
import { cn } from '~/lib/utils';

/** Administration, as Open Chat Interface lays it out: a grouped page list beside the page. */

interface NavItem {
  to:
    | '/admin'
    | '/admin/people'
    | '/admin/agents'
    | '/admin/branding'
    | '/admin/features'
    | '/admin/usage'
    | '/admin/audit';
  label: string;
  icon: LucideIcon;
  /** Shown only while one of these optional features is on. */
  feature?: FeatureId | FeatureId[];
}

const OVERVIEW: NavItem = { to: '/admin', label: 'Overview', icon: LayoutDashboard };
const SECTIONS: { label: string; items: NavItem[] }[] = [
  { label: 'People', items: [{ to: '/admin/people', label: 'People', icon: Users }] },
  {
    label: 'Instance',
    items: [
      { to: '/admin/agents', label: 'Agents', icon: Bot },
      { to: '/admin/branding', label: 'Branding', icon: Palette },
      { to: '/admin/features', label: 'Features', icon: ToggleRight },
    ],
  },
  {
    label: 'Records',
    items: [
      {
        to: '/admin/usage',
        label: 'Usage',
        icon: ChartColumn,
        feature: ['usage', 'connectedUsage'],
      },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
];

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active =
    item.to === '/admin'
      ? pathname === '/admin' || pathname === '/admin/'
      : pathname.startsWith(item.to);
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
      )}
    >
      <item.icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function AdminNav({ pathname }: { pathname: string }) {
  const features = useCurrentUser()?.features ?? {};
  return (
    <nav aria-label="Administration" className="flex flex-col gap-3">
      <NavLink item={OVERVIEW} pathname={pathname} />
      {SECTIONS.map((section) => (
        <div key={section.label}>
          <p className="px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {section.label}
          </p>
          <ul className="flex flex-col gap-px">
            {section.items
              .filter(
                (item) =>
                  !item.feature || [item.feature].flat().some((feature) => features[feature]),
              )
              .map((item) => (
                <li key={item.to}>
                  <NavLink item={item} pathname={pathname} />
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AdminLayout() {
  const { pathname } = useLocation();
  const { data: config } = useAuthConfig();
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--bg-root)] text-[var(--text-primary)] lg:flex-row">
      <SkipLink />
      <aside className="flex shrink-0 flex-col border-b border-[var(--border-subtle)] bg-[var(--bg-app)] bg-[image:var(--sidebar-gradient)] lg:w-64 lg:border-r lg:border-b-0">
        <div className="flex h-14 shrink-0 items-center px-3">
          <Link to="/" className="flex min-w-0 items-center px-2">
            <Wordmark name={config?.instance.name} logoUrl={config?.instance.logoUrl} compact />
          </Link>
        </div>
        <div className="hidden px-4 pb-3 lg:block">
          <p className="text-sm font-semibold">Administration</p>
        </div>
        <div className="scrollbar-thin overflow-x-auto px-2 pb-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pb-4">
          <AdminNav pathname={pathname} />
        </div>
        <div className="hidden border-t border-[var(--border-subtle)] p-2 lg:block">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to chat
          </Link>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 outline-none">
        <div className="scrollbar-thin relative h-full overflow-y-auto">
          <div className="absolute top-4 right-4">
            <ThemeMenu />
          </div>
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}

/** A page's title and what it is for. */
export function AdminHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">{description}</p>
      </div>
      {actions}
    </header>
  );
}

export const timeAgo = (iso: string | null): string => {
  if (!iso) return 'Never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (minutes < 60) return format.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, 'hour');
  return format.format(-Math.round(hours / 24), 'day');
};
