import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Agent, type AgentThread, agentPath, api, threadPath } from '~/api/client';

export const AGENTS_KEY = ['agents'] as const;
export const threadsKey = (agentId: string) => ['agents', agentId, 'threads'] as const;

/** The person's own agents; the server makes their assistant the first time. */
export function useAgents() {
  return useQuery({
    queryKey: AGENTS_KEY,
    queryFn: () => api.get<Agent[]>('/api/agents'),
    staleTime: 30_000,
    // Running/hibernating changes on its own; a slow refresh keeps it roughly current.
    refetchInterval: 60_000,
  });
}

export function useAgent(agentId: string | undefined): Agent | undefined {
  const { data } = useAgents();
  return agentId ? data?.find((agent) => agent.id === agentId) : undefined;
}

/** Agents someone can talk to: enabled ones. */
export function chattable(agents: readonly Agent[] | undefined): Agent[] {
  return (agents ?? []).filter((agent) => agent.enabled);
}

/**
 * An agent's conversations, most recent first. Listing wakes the agent's
 * runtime, so this only runs for agents that are open in the sidebar or on
 * screen (`enabled`).
 */
export function useAgentThreads(agentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: threadsKey(agentId ?? ''),
    queryFn: () => api.get<AgentThread[]>(agentPath(agentId!, '/threads')),
    enabled: Boolean(agentId) && enabled,
    staleTime: 15_000,
  });
}

/** A conversation's title from the cached list, if known. */
export function useThreadTitle(agentId: string, threadId: string): string | undefined {
  const { data } = useAgentThreads(agentId);
  return data?.find((thread) => thread.threadId === threadId)?.title;
}

/** Stops and removes a conversation from the agent's list. */
export function useDeleteThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, threadId }: { agentId: string; threadId: string }) =>
      api.delete(threadPath(agentId, threadId)),
    onMutate: async ({ agentId, threadId }) => {
      await queryClient.cancelQueries({ queryKey: threadsKey(agentId) });
      queryClient.setQueryData<AgentThread[]>(threadsKey(agentId), (threads) =>
        threads?.filter((thread) => thread.threadId !== threadId),
      );
    },
    onSettled: (_data, _error, { agentId }) =>
      queryClient.invalidateQueries({ queryKey: threadsKey(agentId) }),
  });
}

/**
 * Puts a just-started conversation at the top of its agent's list straight
 * away, before the platform lists it (the title is the agent's own: the
 * start of the first message).
 */
export function noteNewThread(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string,
  threadId: string,
  firstMessage: string,
) {
  const now = Date.now();
  queryClient.setQueryData<AgentThread[]>(threadsKey(agentId), (threads) => {
    if (threads?.some((thread) => thread.threadId === threadId)) return threads;
    const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New conversation';
    return [{ threadId, title, createdAt: now, updatedAt: now }, ...(threads ?? [])];
  });
}

/** A new conversation ID, in the form the platform accepts (1-64 of [A-Za-z0-9_-]). */
export function newThreadId(): string {
  return crypto.randomUUID();
}
