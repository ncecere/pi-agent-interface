import type { UIMessage } from 'ai';
import { ChevronDown, Wrench } from 'lucide-react';
import { useId, useState } from 'react';
import { toolOutputText } from '~/lib/chat-view';
import { cn } from '~/lib/utils';
import { isToolPart, summarizeToolPart, type ToolStepSummary } from '~/shared';

export type ToolPart = Record<string, unknown> & { type: string; toolCallId: string };

/** The longest output a step shows before "Show all". */
const OUTPUT_PREVIEW_CHARS = 4_000;

/** The tool parts of a message, with the summary every renderer shows. */
export function toolStepsOf(message: UIMessage): Array<{ part: ToolPart; step: ToolStepSummary }> {
  return message.parts.filter(isToolPart).map((part) => ({
    part: part as ToolPart,
    step: agentToolStep(part as ToolPart),
  }));
}

const INPUT_HINT_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'file',
  'url',
  'query',
  'pattern',
  'name',
] as const;

/** What a call acted on, from its arguments: the command, the file, the query. */
export function inputHint(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of INPUT_HINT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim();
  }
  return null;
}

const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A tool step as the conversation shows it. An agent's tools are its own
 * (bash, read, edit, MCP tools…), so the line names the tool and what it
 * acted on: "bash · ls -la", "read · src/main.ts".
 */
export function agentToolStep(part: ToolPart): ToolStepSummary {
  const step = summarizeToolPart(part);
  const hint = inputHint(part.input);
  const target = hint ? ` · ${clip(hint)}` : '';
  const summary =
    step.state === 'running'
      ? `${step.label}${target}`
      : step.state === 'error'
        ? `${step.label}${target} failed`
        : step.state === 'done'
          ? `${step.label}${target}`
          : step.summary;
  return { ...step, summary };
}

const formatInput = (input: unknown) => {
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return String(input);
  }
};

function ToolOutput({ part, step }: { part: ToolPart; step: ToolStepSummary }) {
  const [all, setAll] = useState(false);
  const text = toolOutputText(part);
  if (step.state === 'denied')
    return (
      <p className="text-[var(--text-muted)]">Not run{step.reason ? `: ${step.reason}` : ''}.</p>
    );
  if (text === null || text === '')
    return (
      <p className="text-[var(--text-muted)]">
        {step.state === 'running'
          ? 'Running…'
          : step.state === 'error'
            ? 'The tool failed.'
            : 'No output.'}
      </p>
    );
  const long = text.length > OUTPUT_PREVIEW_CHARS;
  return (
    <>
      <pre
        className={cn(
          'max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono',
          step.state === 'error' && 'text-[var(--danger-on-tint)]',
        )}
      >
        {long && !all ? `${text.slice(0, OUTPUT_PREVIEW_CHARS)}…` : text}
      </pre>
      {long && (
        <button
          type="button"
          className="mt-1 text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
          onClick={() => setAll(!all)}
        >
          {all ? 'Show less' : `Show all (${text.length.toLocaleString('en-US')} characters)`}
        </button>
      )}
    </>
  );
}

/** One tool call: a one-line summary that expands to its inputs and output. */
export function ToolStepRow({ part, step }: { part: ToolPart; step: ToolStepSummary }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[0.8125rem] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Wrench
          className={cn('size-4 shrink-0', step.state === 'running' && 'animate-pulse')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 break-words font-mono text-[0.78rem]">{step.summary}</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          id={detailsId}
          className="mt-2 space-y-2 rounded-lg bg-black/10 px-3 py-2 text-xs text-[var(--text-secondary)]"
        >
          <div>
            <p className="mb-1 font-medium text-[var(--text-primary)]">Inputs</p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono">
              {formatInput(part.input)}
            </pre>
          </div>
          <div>
            <p className="mb-1 font-medium text-[var(--text-primary)]">
              {step.state === 'running' ? 'Output so far' : 'Output'}
            </p>
            <ToolOutput part={part} step={step} />
          </div>
        </div>
      )}
    </div>
  );
}
