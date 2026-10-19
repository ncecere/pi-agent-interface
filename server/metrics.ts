/**
 * Prometheus metrics (text exposition format 0.0.4), kept small and dependency-free.
 *
 * What the app counts is defined once, in `Metrics`, and called from where it happens. Nothing here is ever
 * sent anywhere: with METRICS_ENABLED=true main.ts serves it on a port of its own (METRICS_PORT), never on the
 * public one, so an ingress that exposes the app does not expose these.
 *
 * Labels are kept to a few known values (a route's pattern, an outcome), never a person, an ID or a path.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

type Labels = Record<string, string>;
type Sample = { labels: Labels; value: number };
type Reading = number | Sample[];
type Collect = Reading | (() => Reading | Promise<Reading>);

const escapeLabel = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const escapeHelp = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join('\u0000');
const render = (name: string, labels: Labels, value: number) => {
  const pairs = Object.keys(labels)
    .sort()
    .map((label) => `${label}="${escapeLabel(labels[label] ?? '')}"`);
  return `${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${Number.isInteger(value) ? value : value.toString()}`;
};

interface Family {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  lines(): Promise<string[]> | string[];
}

export class Registry {
  private readonly families: Family[] = [];

  private add(family: Family) {
    this.families.push(family);
  }

  counter(name: string, help: string) {
    const values = new Map<string, Sample>();
    this.add({
      name,
      help,
      type: 'counter',
      lines: () => [...values.values()].map((s) => render(name, s.labels, s.value)),
    });
    return {
      inc(labels: Labels = {}, by = 1) {
        const k = key(labels);
        const sample = values.get(k);
        if (sample) sample.value += by;
        else values.set(k, { labels, value: by });
      },
    };
  }

  /** A gauge read when scraped: `collect` returns one value, or several with labels. */
  gauge(name: string, help: string, collect: Collect, type: 'gauge' | 'counter' = 'gauge') {
    this.add({
      name,
      help,
      type,
      lines: async () => {
        const got = typeof collect === 'function' ? await collect() : collect;
        const samples = typeof got === 'number' ? [{ labels: {}, value: got }] : got;
        return samples.map((s) => render(name, s.labels, s.value));
      },
    });
  }

  histogram(name: string, help: string, buckets: number[]) {
    const series = new Map<
      string,
      { labels: Labels; counts: number[]; sum: number; count: number }
    >();
    const sorted = [...buckets].sort((a, b) => a - b);
    this.add({
      name,
      help,
      type: 'histogram',
      lines: () =>
        [...series.values()].flatMap((s) => [
          ...sorted.map((le, i) =>
            render(`${name}_bucket`, { ...s.labels, le: String(le) }, s.counts[i] ?? 0),
          ),
          render(`${name}_bucket`, { ...s.labels, le: '+Inf' }, s.count),
          render(`${name}_sum`, s.labels, s.sum),
          render(`${name}_count`, s.labels, s.count),
        ]),
    });
    return {
      observe(value: number, labels: Labels = {}) {
        const k = key(labels);
        let s = series.get(k);
        if (!s) {
          s = { labels, counts: sorted.map(() => 0), sum: 0, count: 0 };
          series.set(k, s);
        }
        sorted.forEach((le, i) => {
          if (value <= le) s.counts[i] = (s.counts[i] ?? 0) + 1;
        });
        s.sum += value;
        s.count += 1;
      },
    };
  }

  async render(): Promise<string> {
    const out: string[] = [];
    for (const family of this.families) {
      let lines: string[];
      try {
        lines = await family.lines();
      } catch {
        continue; // a gauge that cannot be read is left out, not the whole scrape
      }
      if (lines.length === 0) continue;
      out.push(
        `# HELP ${family.name} ${escapeHelp(family.help)}`,
        `# TYPE ${family.name} ${family.type}`,
        ...lines,
      );
    }
    return `${out.join('\n')}\n`;
  }
}

/** How a call to the platform ended, for `pai_platform_requests_total`. */
export type PlatformOutcome =
  | 'ok'
  | 'client_error'
  | 'server_error'
  | 'network_error'
  | 'not_connected';
export const outcomeOfStatus = (status: number): PlatformOutcome =>
  status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'ok';

export type SignInOutcome = 'ok' | 'suspended' | 'not_allowed' | 'failed' | 'expired';
export type RefreshOutcome = 'ok' | 'ended' | 'error';

export class Metrics {
  readonly registry = new Registry();

  private readonly requests = this.registry.counter(
    'pai_http_requests_total',
    'Requests this app answered, by method, route pattern and status.',
  );
  private readonly latency = this.registry.histogram(
    'pai_http_request_duration_seconds',
    'How long a request took, by method and route pattern until the response begins; a stream goes on after that.',
    [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  );
  private readonly platformCalls = this.registry.counter(
    'pai_platform_requests_total',
    "Requests to the agent platform, by how they ended (a person's 'not_connected' included).",
  );
  private readonly refreshes = this.registry.counter(
    'pai_connect_token_refreshes_total',
    "Refreshes of a person's platform token: ok, ended (the platform ended the connection) or error.",
  );
  private readonly signIns = this.registry.counter(
    'pai_sign_ins_total',
    'Sign-in attempts by how they ended.',
  );

  constructor(version = 'unknown') {
    const r = this.registry;
    r.gauge('pai_build_info', 'The version of this build, as a label.', [
      { labels: { version }, value: 1 },
    ]);
    r.gauge(
      'process_start_time_seconds',
      'When the process started (Unix time).',
      Math.floor(Date.now() / 1000 - process.uptime()),
    );
    // A counter that is read when scraped.
    r.gauge(
      'process_cpu_seconds_total',
      'CPU time used by the process.',
      () => {
        const usage = process.cpuUsage();
        return (usage.user + usage.system) / 1e6;
      },
      'counter',
    );
    r.gauge('process_resident_memory_bytes', 'Resident memory.', () => process.memoryUsage.rss());
    r.gauge('nodejs_heap_used_bytes', 'Heap in use.', () => process.memoryUsage().heapUsed);
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    r.gauge(
      'nodejs_eventloop_lag_p99_seconds',
      'The 99th percentile of event-loop delay since the last scrape.',
      () => {
        const seconds = Number.isFinite(lag.percentile(99)) ? lag.percentile(99) / 1e9 : 0;
        lag.reset();
        return seconds;
      },
    );
  }

  http(method: string, route: string, status: number, seconds: number) {
    this.requests.inc({ method, route, status: String(status) });
    this.latency.observe(seconds, { method, route });
  }
  platform(outcome: PlatformOutcome) {
    this.platformCalls.inc({ outcome });
  }
  refresh(outcome: RefreshOutcome) {
    this.refreshes.inc({ outcome });
  }
  signIn(outcome: SignInOutcome) {
    this.signIns.inc({ outcome });
  }

  /** A gauge the app registers for what only it knows (open streams, the database). */
  gauge(name: string, help: string, collect: Collect) {
    this.registry.gauge(name, help, collect);
  }

  render() {
    return this.registry.render();
  }
}
