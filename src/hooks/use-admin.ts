import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/api/client';
import { AUTH_CONFIG_KEY, ME_KEY } from '~/hooks/use-session';

export interface AdminPerson {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  status: 'active' | 'suspended';
  createdAt: string;
  lastSeenAt: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorId: string | null;
  action: string;
  targetId: string | null;
  details: Record<string, unknown>;
}

export interface Overview {
  people: number;
  admins: number;
  suspended: number;
  activeToday: number;
  activeThisWeek: number;
  newThisMonth: number;
}

export interface Branding {
  name: string;
  logoUrl: string | null;
  colorTheme: 'neutral' | 'blue' | 'violet' | 'emerald';
  defaultTheme: 'light' | 'dark' | 'system';
}

const PEOPLE = ['admin', 'people'] as const;

export const useOverview = () =>
  useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<Overview>('/api/admin/overview'),
  });

export const usePeople = (search: string) =>
  useQuery({
    queryKey: [...PEOPLE, search],
    queryFn: () =>
      api.get<AdminPerson[]>(
        `/api/admin/people${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
    placeholderData: (previous) => previous,
  });

export const useAudit = (limit = 200) =>
  useQuery({
    queryKey: ['admin', 'audit', limit],
    queryFn: () => api.get<AuditEntry[]>(`/api/admin/audit?limit=${limit}`),
  });

export function useUpdatePerson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...change
    }: {
      id: string;
      role?: AdminPerson['role'];
      status?: AdminPerson['status'];
    }) => api.patch<AdminPerson>(`/api/admin/people/${encodeURIComponent(id)}`, change),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export const useBranding = () =>
  useQuery({
    queryKey: ['admin', 'branding'],
    queryFn: () => api.get<Branding>('/api/admin/settings/branding'),
  });

export function useSaveBranding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (branding: Branding) => api.put<Branding>('/api/admin/settings/branding', branding),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      void queryClient.invalidateQueries({ queryKey: AUTH_CONFIG_KEY });
    },
  });
}

export interface AgentSettings {
  defaultModelId: string | null;
  personalLimit: number;
  allowModelChoice: boolean;
  allowedTemplateIds: string[] | null;
}

export interface ProvidedAgent {
  id: string;
  name: string;
  description: string;
  templateId: string | null;
  modelId: string | null;
}

export interface AgentsAdmin {
  settings: AgentSettings;
  provided: ProvidedAgent[];
  models: { id: string; name: string }[];
  templates: { id: string; name: string; description: string; team: boolean }[];
  environmentModel: string | null;
}

export const useAgentsAdmin = () =>
  useQuery({
    queryKey: ['admin', 'agents'],
    queryFn: () => api.get<AgentsAdmin>('/api/admin/agents'),
  });

export function useSaveAgentSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: AgentSettings) =>
      api.put<AgentSettings>('/api/admin/settings/agents', settings),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useSaveProvided() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agents: ProvidedAgent[]) =>
      api.put<ProvidedAgent[]>('/api/admin/settings/provided', { agents }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
