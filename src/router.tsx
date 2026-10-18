import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { onSessionEnded } from '~/api/client';
import { AppShell } from '~/components/layout/app-shell';
import { NotFoundPage } from '~/components/ui/not-found-page';
import { RouteLoadError } from '~/components/ui/route-load-error';
import { FullPageSpinner } from '~/components/ui/spinner';
import { useNewChatKey } from '~/hooks/use-new-chat-key';
import { forgetSession, loadSession } from '~/hooks/use-session';
import { SignInPage } from '~/routes/auth/sign-in';
import { ChatHomePage } from '~/routes/chat/home';
import { ChatThreadPage } from '~/routes/chat/thread';

/** `?next=` for sign-in, so it comes back to the page that needed a session. */
const signInSearch = (href: string) => (href && href !== '/' ? { next: href } : {});

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <main className="h-dvh">
      <NotFoundPage />
    </main>
  ),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInPage,
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    if (session) {
      const next = new URLSearchParams(location.searchStr).get('next');
      throw redirect({ href: next?.startsWith('/') && !next.startsWith('//') ? next : '/' });
    }
  },
});

/**
 * A review page for the avatar styles. Development only: in a production build
 * the condition is constant, so the page is not even in the bundle.
 */
const avatarsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/avatars',
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import('~/routes/demo/avatars'), 'AvatarsDemoPage')
    : () => <NotFoundPage />,
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    if (!session) throw redirect({ to: '/sign-in', search: signInSearch(location.href) as never });
    return { session };
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  pendingComponent: FullPageSpinner,
});

const chatHomeRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    typeof search.agent === 'string' && search.agent ? { agent: search.agent } : {},
  component: function ChatHomeRoute() {
    const { agent } = chatHomeRoute.useSearch();
    // A fresh page for each New Chat.
    const fresh = useNewChatKey();
    return <ChatHomePage key={fresh} agentId={agent} />;
  },
});

const agentRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/agents/$agentId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/', search: { agent: params.agentId } });
  },
});

const threadRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/agents/$agentId/threads/$threadId',
  component: function ThreadRoute() {
    const { agentId, threadId } = threadRoute.useParams();
    return <ChatThreadPage agentId={agentId} threadId={threadId} />;
  },
});

/** Settings: a page of its own (no chat sidebar), as in Open Chat Interface. */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'settings',
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    if (!session) throw redirect({ to: '/sign-in', search: signInSearch(location.href) as never });
    return { session };
  },
  component: lazyRouteComponent(
    () => import('~/components/settings/settings-layout'),
    'SettingsLayout',
  ),
  pendingComponent: FullPageSpinner,
});

const settingsPage = <P extends string>(
  path: P,
  component: ReturnType<typeof lazyRouteComponent>,
) => createRoute({ getParentRoute: () => settingsRoute, path, component });

const settingsChildren = [
  settingsPage(
    '/settings',
    lazyRouteComponent(() => import('~/routes/settings/account'), 'SettingsAccountPage'),
  ),
  settingsPage(
    '/settings/customization',
    lazyRouteComponent(
      () => import('~/routes/settings/customization'),
      'SettingsCustomizationPage',
    ),
  ),
  settingsPage(
    '/settings/conversations',
    lazyRouteComponent(
      () => import('~/routes/settings/conversations'),
      'SettingsConversationsPage',
    ),
  ),
];

const routeTree = rootRoute.addChildren([
  signInRoute,
  avatarsRoute,
  authenticatedRoute.addChildren([chatHomeRoute, agentRoute, threadRoute]),
  settingsRoute.addChildren(settingsChildren),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: FullPageSpinner,
  defaultErrorComponent: RouteLoadError,
  defaultNotFoundComponent: () => <NotFoundPage />,
});

/** The session ended while the app was open: to sign-in, then back here. */
onSessionEnded(() => {
  forgetSession();
  const { pathname, href } = router.state.location;
  if (pathname === '/sign-in') return;
  void router.navigate({
    to: '/sign-in',
    search: { 'signed-out': 1, ...signInSearch(href) } as never,
  });
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
