import type { Agent } from '~/api/client';
import { cn } from '~/lib/utils';

/** Hues that read on both themes; an agent keeps its hue across sessions. */
const HUES = [212, 262, 330, 24, 152, 190, 45, 290] as const;

function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return HUES[hash % HUES.length]!;
}

export function initialsOf(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/** An agent's mark: its initials on its own colour, with a dot while its runtime is up. */
export function AgentAvatar({
  agent,
  size = 'md',
  showStatus = false,
  className,
}: {
  agent: Pick<Agent, 'id' | 'name' | 'running' | 'enabled'>;
  size?: 'sm' | 'md' | 'lg';
  showStatus?: boolean;
  className?: string;
}) {
  const hue = hueOf(agent.id);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-lg font-semibold tracking-tight',
        size === 'sm' && 'size-5 rounded-md text-[0.5625rem]',
        size === 'md' && 'size-7 text-[0.6875rem]',
        size === 'lg' && 'size-11 rounded-xl text-base',
        !agent.enabled && 'opacity-50 grayscale',
        className,
      )}
      style={{
        background: `oklch(0.62 0.13 ${hue} / 0.22)`,
        color: `oklch(0.78 0.12 ${hue})`,
        boxShadow: `inset 0 0 0 1px oklch(0.7 0.12 ${hue} / 0.35)`,
      }}
    >
      {initialsOf(agent.name)}
      {showStatus && agent.running && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2 border-[var(--bg-app)] bg-[var(--success)]" />
      )}
    </span>
  );
}

/** "Running", "Asleep" or "Disabled", for labels and tooltips. */
export function agentStatusLabel(agent: Pick<Agent, 'running' | 'enabled'>): string {
  if (!agent.enabled) return 'Disabled';
  return agent.running ? 'Running' : 'Asleep: wakes on your next message';
}
