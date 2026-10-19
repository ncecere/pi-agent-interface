#!/usr/bin/env node
// A small stand-in for pi-durable-platform, for the capture stack only: the subset of its API that Pi Agent Interface
// calls (see the product's server/platform.ts, server/connect.ts, server/connect-agents.ts, server/events-hub.ts and the
// platform's api/openapi.yaml), over plain HTTP on 127.0.0.1, with canned Example Corp data (stack/world.mjs). It makes
// no network requests and holds no secrets.
//
//   node fake-platform.mjs            # FAKE_PORT (8199), FAKE_URL (http://localhost:8199), FAKE_TZ, FAKE_SERVICE_TEAM
//
// Two ways in, as in the product:
//   - Connect: OAuth (register, authorize, token, revoke) and a bearer token per person; their personal workspace and
//     the shared team Research.
//   - Service account: `Authorization: Bearer pdp_sa_...` for the team `example-corp`; agents made by key.
//
// Control endpoints for the capture scripts (never part of the platform): POST /__demo/connect-as, /__demo/anchor,
// /__demo/thread, /__demo/membership; GET /__demo/inbox, /__demo/state.
import { createServer } from 'node:http';
import {
  appPersonId,
  conversations,
  DAY,
  FINANCE_ID,
  FINANCE_MEMBERS,
  MIN,
  MODELS,
  PEOPLE,
  personByEmail,
  TEAM_ID,
  TEMPLATES,
  USAGE_WEIGHTS,
  uuid,
} from './world.mjs';

const PORT = Number(process.env.FAKE_PORT ?? 8199);
const BASE = (process.env.FAKE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const OFFICE_ZONE = process.env.FAKE_TZ ?? 'America/Los_Angeles';
const SERVICE_TEAM = process.env.FAKE_SERVICE_TEAM ?? 'example-corp';
const SERVICE_KEY_PREFIX = 'pdp_sa_';

let anchor = Date.now();

// ── State ────────────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, any>} id -> agent */
const agents = new Map();
/** agentId -> Map(threadId -> thread) */
const threads = new Map();
const teams = new Map();
const codes = new Map(); // code -> email
let counter = 0;
// Tokens carry their person (nothing to remember), so the apps' stored connections survive a restart of this fake.
const mint = (kind, email) =>
  `pdp${kind}_${Buffer.from(JSON.stringify({ e: email, n: ++counter, t: Date.now() })).toString('base64url')}`;
const personOfToken = (token) => {
  try {
    const email = JSON.parse(
      Buffer.from(String(token).slice(String(token).indexOf('_') + 1), 'base64url').toString(),
    ).e;
    return personByEmail(email)?.email ?? null;
  } catch {
    return null;
  }
};
let connectAs = personByEmail(process.env.FAKE_CONNECT_AS ?? 'priya.shah@example.com')?.email;
/** Who belongs to the team Finance now. Priya joins during the capture session (POST /__demo/membership). */
const financeMembers = new Set(FINANCE_MEMBERS.filter((id) => id !== 'priya'));
/** SSE subscribers. */
const eventSubs = new Set(); // { principal, res, agentId }
const threadSubs = new Set(); // { principal, res, agentId, threadId }
const timers = new Map(); // agentId/threadId -> [timeouts]

const personalTeam = (person) => {
  const slug = `personal-${person.id}`;
  if (!teams.has(slug))
    teams.set(slug, {
      id: uuid(`team:${slug}`),
      slug,
      name: person.name,
      description: '',
      status: 'active',
      kind: 'personal',
      revision: 1,
      createdAt: new Date(anchor - 60 * DAY).toISOString(),
      updatedAt: new Date(anchor - 60 * DAY).toISOString(),
      owner: person.email,
    });
  return teams.get(slug);
};

function resetWorld() {
  agents.clear();
  threads.clear();
  teams.clear();
  teams.set('finance', {
    id: FINANCE_ID,
    slug: 'finance',
    name: 'Finance',
    description: 'The finance team',
    status: 'active',
    kind: 'team',
    revision: 1,
    createdAt: new Date(anchor - 90 * DAY).toISOString(),
    updatedAt: new Date(anchor - 90 * DAY).toISOString(),
  });
  teams.set(SERVICE_TEAM, {
    id: TEAM_ID,
    slug: SERVICE_TEAM,
    name: 'Example Corp',
    description: 'Pi Agent Interface service account team',
    status: 'active',
    kind: 'team',
    revision: 1,
    createdAt: new Date(anchor - 90 * DAY).toISOString(),
    updatedAt: new Date(anchor - 90 * DAY).toISOString(),
  });
  // The team agent of Finance.
  makeAgent({
    team: teams.get('finance'),
    name: 'Close checklist',
    description: 'Walks the finance team through the month-end close',
    template: TEMPLATES.general,
    model: MODELS[0],
    running: false,
  });
  // An agent someone made by hand in the service team's console (shows as "Other agents" in usage).
  makeAgent({
    team: teams.get(SERVICE_TEAM),
    name: 'Release helper',
    description: 'Made by hand in the console',
    template: TEMPLATES.general,
    model: MODELS[1],
    running: false,
  });
}

function agentView(agent) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    teamId: agent.team.id,
    teamSlug: agent.team.slug,
    teamName: agent.team.name,
    templateId: agent.template.id,
    templateSlug: agent.template.slug,
    templateName: agent.template.name,
    templateVersion: 1,
    templateCurrentVersion: 1,
    ...(agent.externalKey ? { externalKey: agent.externalKey } : { externalKey: null }),
    enabled: true,
    running: agent.running,
    model: agent.model
      ? { id: agent.model.id, name: agent.model.name, source: 'agent', available: true }
      : null,
    lastUsedAt: null,
    revision: agent.revision,
    createdAt: new Date(agent.createdAt).toISOString(),
    updatedAt: new Date(agent.updatedAt).toISOString(),
  };
}

function makeAgent({
  team,
  name,
  description = '',
  template,
  model,
  externalKey = null,
  running = false,
  owner = null,
}) {
  const id = uuid(`agent:${team.slug}:${externalKey ?? name}`);
  const agent = {
    id,
    team,
    name,
    description,
    template,
    model,
    externalKey,
    running,
    owner,
    revision: 1,
    createdAt: anchor - 30 * DAY,
    updatedAt: anchor - 30 * DAY,
  };
  agents.set(id, agent);
  threads.set(id, new Map());
  attachThreads(agent);
  return agent;
}

/**
 * Canned conversations for the agents of a person: in a personal workspace (Connect), the team agent's members, and in
 * the service team an agent made by key for a person (its key names them; the platform's name for it is "<name> · <person>").
 */
function attachThreads(agent) {
  let owners = [];
  let name = agent.name;
  if (agent.team.kind === 'personal') owners = [agent.team.owner];
  else if (agent.team.slug === 'finance')
    owners = FINANCE_MEMBERS.map((id) => PEOPLE.find((p) => p.id === id).email);
  else if (agent.externalKey) {
    const hash = /^u:([a-f0-9]{40})/.exec(agent.externalKey)?.[1];
    const person = hash && PEOPLE.find((p) => appPersonId(p.id) === hash);
    if (person) {
      owners = [person.email];
      name = agent.name.split(' · ')[0];
    }
  }
  for (const email of owners)
    for (const spec of conversations(email, name, { anchor, officeZone: OFFICE_ZONE }))
      addThread(agent, email, spec);
}

function addThread(agent, ownerEmail, spec) {
  const person = personByEmail(ownerEmail);
  const t = {
    threadId: spec.threadId,
    title: spec.title,
    createdAt: anchor - spec.createdAge,
    updatedAt: anchor - spec.updatedAge,
    busy: Boolean(spec.busy),
    lastReplyAt: spec.replyAge == null ? null : anchor - spec.replyAge,
    lastError: spec.error ?? null,
    visibility: 'private',
    createdBy: { kind: 'user', id: uuid(`user:${ownerEmail}`), name: person?.name ?? ownerEmail },
    participants: [
      {
        kind: 'user',
        id: uuid(`user:${ownerEmail}`),
        name: person?.name ?? ownerEmail,
        lastSentAt: anchor - spec.updatedAge,
      },
    ],
    owner: ownerEmail,
    messages: spec.messages,
    partial: spec.partial ?? null,
    tools: spec.tools ?? [],
    flags: {
      pinned: spec.pinned,
      unread: spec.unread,
      woke: spec.woke,
      noReply: spec.noReply,
      snoozed: spec.snoozed,
      settledAgo: spec.settled,
      archivedAgo: spec.archived,
      busy: spec.busy,
    },
  };
  threads.get(agent.id).set(t.threadId, t);
  return t;
}

/** Re-anchor: every canned time moves by the difference, so "now" is now again (runtime changes are kept). */
function reanchor(next) {
  const delta = next - anchor;
  anchor = next;
  const shiftAgent = (a) => {
    a.createdAt += delta;
    a.updatedAt += delta;
  };
  for (const a of agents.values()) shiftAgent(a);
  for (const map of threads.values())
    for (const t of map.values()) {
      t.createdAt += delta;
      t.updatedAt += delta;
      if (t.lastReplyAt != null) t.lastReplyAt += delta;
      for (const p of t.participants) p.lastSentAt += delta;
      for (const m of t.messages) {
        if (m.at != null) m.at += delta;
        for (const c of m.toolCalls ?? []) {
          if (c.startedAt != null) c.startedAt += delta;
          if (c.endedAt != null) c.endedAt += delta;
        }
      }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

const json = (res, data, status = 200, headers = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify({ data }));
};
const fail = (res, status, code, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
};
const plain = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};
const readBody = (req) =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
    });
    req.on('end', () => resolve(text));
  });
const parseJson = (text) => {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
};

/** The caller: a person (an access token from Connect) or the team service account. */
function principalOf(req) {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (bearer.startsWith(SERVICE_KEY_PREFIX)) return { kind: 'service' };
  const email = bearer.startsWith('pdpat_') ? personOfToken(bearer) : null;
  return email ? { kind: 'user', email, person: personByEmail(email) } : null;
}

const teamsOf = (principal) => {
  if (principal.kind === 'service') return [teams.get(SERVICE_TEAM)];
  const list = [personalTeam(principal.person)];
  if (financeMembers.has(principal.person.id)) list.push(teams.get('finance'));
  return list;
};
const canUseAgent = (principal, agent) => teamsOf(principal).some((t) => t.id === agent.team.id);
const visibleThread = (principal, t) => principal.kind === 'service' || t.owner === principal.email;

const threadView = (t) => ({
  threadId: t.threadId,
  title: t.title,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  busy: t.busy,
  ...(t.lastReplyAt != null ? { lastReplyAt: t.lastReplyAt } : {}),
  ...(t.lastError ? { lastError: t.lastError } : {}),
  visibility: t.visibility,
  createdBy: t.createdBy,
  participants: t.participants,
});
const chatView = (t) => ({
  busy: t.busy,
  messages: t.messages,
  ...(t.partial ? { partial: t.partial } : {}),
  tools: t.tools,
});

const sse = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
};
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function emitThread(agent, t, deleted = false) {
  for (const sub of eventSubs) {
    if (!canUseAgent(sub.principal, agent) || (sub.agentId && sub.agentId !== agent.id)) continue;
    if (!deleted && !visibleThread(sub.principal, t)) continue;
    send(sub.res, 'thread', {
      agentId: agent.id,
      threadId: t.threadId,
      deleted,
      ...(deleted ? {} : { thread: threadView(t) }),
    });
  }
}
function emitView(agent, t) {
  for (const sub of threadSubs)
    if (sub.agentId === agent.id && sub.threadId === t.threadId) send(sub.res, 'view', chatView(t));
}
setInterval(() => {
  for (const sub of [...eventSubs, ...threadSubs]) sub.res.write(': keep-alive\n\n');
}, 15_000).unref();

// ── Replies (a message sent from the app is answered with a canned reply, streamed) ────────────────

const CANNED =
  'Understood. I will look into that and come back with what I find. In the meantime, tell me if there is a deadline or a format you would like the answer in.';

function startReply(agent, t) {
  const key = `${agent.id}/${t.threadId}`;
  for (const id of timers.get(key) ?? []) clearTimeout(id);
  const ids = [];
  timers.set(key, ids);
  t.busy = true;
  t.partial = { text: '', thinking: 'Reading the message and deciding what to do first.' };
  t.tools = [];
  agent.running = true;
  emitThread(agent, t);
  emitView(agent, t);
  const words = CANNED.split(' ');
  words.forEach((_, i) => {
    ids.push(
      setTimeout(
        () => {
          t.partial = { text: words.slice(0, i + 1).join(' '), thinking: t.partial.thinking };
          emitView(agent, t);
        },
        900 + i * 90,
      ),
    );
  });
  ids.push(
    setTimeout(
      () => {
        t.messages.push({
          id: `e${t.messages.length + 1}`,
          role: 'assistant',
          text: CANNED,
          at: Date.now(),
          model: { provider: 'example', id: 'chat-model' },
          stopReason: 'stop',
        });
        t.busy = false;
        t.partial = null;
        t.lastReplyAt = Date.now();
        t.lastError = null;
        t.updatedAt = Date.now();
        emitThread(agent, t);
        emitView(agent, t);
      },
      900 + words.length * 90 + 300,
    ),
  );
}

// ── Usage (deterministic) ────────────────────────────────────────────────────────────────────

const hash01 = (s) => parseInt(uuid(s).slice(0, 8), 16) / 0xffffffff;
const dayString = (ms) => new Date(ms).toISOString().slice(0, 10);

function usageFor(team, query) {
  const groupBy = query.get('groupBy') ?? 'day';
  const to = query.get('to') ?? dayString(Date.now());
  const from = query.get('from') ?? dayString(Date.parse(to) - 29 * DAY);
  const onlyAgent = query.get('agentId');
  const days = [];
  for (let d = Date.parse(from); d <= Date.parse(to); d += DAY) days.push(dayString(d));
  const rows = [];
  for (const agent of agents.values()) {
    if (agent.team.id !== team.id || (onlyAgent && agent.id !== onlyAgent)) continue;
    const devId = /^u:([a-f0-9]{40})/.exec(agent.externalKey ?? '')?.[1];
    const person = devId ? PEOPLE.find((p) => appPersonId(p.id) === devId) : null;
    const personalOwner = agent.team.kind === 'personal' ? agent.team.owner : null;
    let weight = person ? (USAGE_WEIGHTS[person.id] ?? 0) : 0;
    if (!person && !personalOwner) weight = agent.name === 'Release helper' ? 1.4 : 0;
    if (personalOwner)
      weight =
        { Assistant: 9, 'Research helper': 5, 'HR Helper': 1.2, 'Release notes': 2 }[agent.name] ??
        1;
    // A person's use is mostly the assistant; the HR helper hardly at all; their own agent in between.
    if (person || personalOwner) {
      const base = agent.name.split(' · ')[0];
      weight *=
        base === 'Assistant' ? 1 : base.startsWith('HR Helper') ? 0.02 : personalOwner ? 1 : 0.55;
    }
    if (!weight) continue;
    const price = (agent.model ?? MODELS[0]).price;
    for (const day of days) {
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      const factor = dow === 0 || dow === 6 ? 0.18 : 1;
      const jitter = 0.45 + hash01(`${agent.id}:${day}`);
      const requests = Math.round(weight * factor * jitter);
      if (!requests) continue;
      const inputTokens = Math.round(requests * (1800 + hash01(`i${agent.id}${day}`) * 1500));
      const outputTokens = Math.round(requests * (420 + hash01(`o${agent.id}${day}`) * 520));
      rows.push({
        day,
        agentId: agent.id,
        agentName: agent.name,
        managed: Boolean(agent.externalKey),
        requests,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: Math.round(inputTokens * price.in + outputTokens * price.out) / 1_000_000,
        unpricedRequests: 0,
        teamId: team.id,
        teamSlug: team.slug,
        teamName: team.name,
      });
    }
  }
  const sum = (list, extra) =>
    list.reduce(
      (a, r) => ({
        ...a,
        requests: a.requests + r.requests,
        inputTokens: a.inputTokens + r.inputTokens,
        outputTokens: a.outputTokens + r.outputTokens,
        costUsd: a.costUsd + r.costUsd,
      }),
      {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        unpricedRequests: 0,
        managed: false,
        ...extra,
      },
    );
  if (groupBy === 'agent') {
    const by = new Map();
    for (const r of rows) by.set(r.agentId, [...(by.get(r.agentId) ?? []), r]);
    return [...by.values()].map((list) =>
      sum(list, {
        agentId: list[0].agentId,
        agentName: list[0].agentName,
        managed: list[0].managed,
      }),
    );
  }
  const by = new Map();
  for (const r of rows) by.set(r.day, [...(by.get(r.day) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => sum(list, { day }));
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────────

const find = (team) => teams.get(team) ?? [...teams.values()].find((t) => t.id === team);

async function route(req, res) {
  const url = new URL(req.url, BASE);
  const method = req.method ?? 'GET';
  const path = url.pathname;
  let m;

  // Control (capture scripts).
  if (path.startsWith('/__demo/')) {
    if (path === '/__demo/connect-as' && method === 'POST') {
      const body = parseJson(await readBody(req));
      if (!personByEmail(body.email)) return fail(res, 400, 'unknown', 'no such person');
      connectAs = personByEmail(body.email).email;
      return json(res, { connectAs });
    }
    if (path === '/__demo/membership' && method === 'POST') {
      // { email, member: true|false }: joins or leaves the team Research (their agents appear or go).
      const body = parseJson(await readBody(req));
      const person = personByEmail(body.email);
      if (!person) return fail(res, 400, 'unknown', 'no such person');
      if (body.member) financeMembers.add(person.id);
      else financeMembers.delete(person.id);
      return json(res, { members: [...financeMembers] });
    }
    if (path === '/__demo/anchor' && method === 'POST') {
      reanchor(Date.now());
      return json(res, { anchor });
    }
    if (path === '/__demo/inbox' && method === 'GET') {
      // What the seed needs to write a person's inbox: each thread, by agent name, with its flags and times.
      const email = url.searchParams.get('email');
      const world = url.searchParams.get('world'); // 'service' or 'connect' (the agents of the service team, or the others)
      const out = [];
      for (const agent of agents.values())
        for (const t of threads.get(agent.id).values())
          if (
            t.owner === email &&
            (!world || (world === 'service') === (agent.team.slug === SERVICE_TEAM))
          )
            out.push({
              agentId: agent.id,
              agentName: agent.name.split(' · ')[0],
              agentTeam: agent.team.slug,
              ...t,
              messages: undefined,
              tools: undefined,
            });
      return json(res, { anchor, threads: out });
    }
    if (path === '/__demo/bulk' && method === 'POST') {
      // Many conversations at once, for a person who has used the app for a long time: { email, count, agentId? }.
      // Each has a title like "Conversation 0042: quarterly planning notes", is older the higher its number, and has a short reply.
      const body = parseJson(await readBody(req));
      const owner = body.email;
      const count = Math.min(Number(body.count) || 0, 20000);
      const target = (body.agentId && agents.get(body.agentId)) || [...agents.values()].find(
        (a) => (!body.agentName || a.name.split(' · ')[0] === body.agentName) && threads.get(a.id) && [...threads.get(a.id).values()].some((t) => t.owner === owner),
      );
      if (!target) return fail(res, 404, 'not_found', 'no agent with conversations for that person');
      const topics = ['quarterly planning notes', 'expense policy question', 'release checklist', 'draft the all-hands update', 'summarise the incident review', 'travel plan', 'onboarding questions', 'budget variance'];
      for (let i = 0; i < count; i++) {
        const id = `t-bulk-${String(i).padStart(5, '0')}`;
        if (threads.get(target.id).has(id)) continue;
        addThread(target, owner, {
          threadId: id,
          title: `Conversation ${String(i).padStart(4, '0')}: ${topics[i % topics.length]}`,
          createdAge: (i + 3) * 20 * MIN,
          updatedAge: (i + 3) * 20 * MIN,
          replyAge: (i + 3) * 20 * MIN - MIN,
          messages: [
            { id: 'e1', role: 'user', text: `Question ${i}`, at: anchor - (i + 3) * 20 * MIN },
            { id: 'e2', role: 'assistant', text: `Answer ${i}`, at: anchor - (i + 3) * 20 * MIN + MIN, model: { provider: 'example', id: 'chat-model' }, stopReason: 'stop' },
          ],
        });
      }
      return json(res, { agentId: target.id, threads: threads.get(target.id).size });
    }
    if (path === '/__demo/thread' && method === 'POST') {
      // Change a thread: { agentId, threadId, busy?, title? }
      const body = parseJson(await readBody(req));
      const agent = agents.get(body.agentId);
      const t = agent && threads.get(agent.id).get(body.threadId);
      if (!t) return fail(res, 404, 'not_found', 'no such thread');
      if (typeof body.busy === 'boolean') t.busy = body.busy;
      if (typeof body.title === 'string') t.title = body.title;
      emitThread(agent, t);
      emitView(agent, t);
      return json(res, threadView(t));
    }
    if (path === '/__demo/state' && method === 'GET')
      return json(res, {
        anchor,
        agents: [...agents.values()].map((a) => ({
          id: a.id,
          name: a.name,
          team: a.team.slug,
          key: a.externalKey,
          threads: threads.get(a.id).size,
        })),
        connectAs,
      });
    return fail(res, 404, 'not_found', 'Not found');
  }

  if (path === '/healthz') return plain(res, 200, 'ok');

  // Discovery and OAuth.
  if (path === '/v1/auth/config')
    return json(res, {
      connect: {
        issuer: BASE,
        authorizationEndpoint: `${BASE}/oauth/authorize`,
        tokenEndpoint: `${BASE}/oauth/token`,
        revocationEndpoint: `${BASE}/oauth/revoke`,
        registrationEndpoint: `${BASE}/oauth/register`,
      },
    });
  if (path === '/oauth/register' && method === 'POST') {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ client_id: `pdpc_${uuid(`client:${Date.now()}`).slice(0, 12)}` }),
    );
  }
  if (path === '/oauth/authorize') {
    // The person is already signed in to the platform and has approved this app before: straight back with a code.
    const redirect = url.searchParams.get('redirect_uri');
    if (!redirect) return plain(res, 400, 'redirect_uri is required');
    const code = `pdpcode_${++counter}_${Math.random().toString(36).slice(2, 10)}`;
    codes.set(code, connectAs);
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    back.searchParams.set('iss', BASE);
    res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (path === '/oauth/token' && method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    let email;
    if (form.get('grant_type') === 'authorization_code') {
      email = codes.get(form.get('code'));
      codes.delete(form.get('code'));
    } else {
      email = String(form.get('refresh_token')).startsWith('pdprt_')
        ? personOfToken(form.get('refresh_token'))
        : null;
    }
    if (!email) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ error: 'invalid_grant', error_description: 'The grant is not valid.' }),
      );
    }
    const at = mint('at', email);
    const rt = mint('rt', email);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(
      JSON.stringify({
        access_token: at,
        refresh_token: rt,
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );
  }
  if (path === '/oauth/revoke' && method === 'POST') {
    await readBody(req); // nothing to forget: tokens are stateless here
    res.writeHead(200);
    return res.end();
  }

  // Everything below needs a bearer.
  const principal = principalOf(req);
  if (!principal) return fail(res, 401, 'unauthorized', 'Sign in to continue');

  if (path === '/v1/me')
    return json(
      res,
      principal.kind === 'user'
        ? {
            user: {
              id: uuid(`user:${principal.email}`),
              email: principal.email,
              displayName: principal.person.name,
            },
          }
        : { user: { id: uuid('service-account'), email: '', displayName: 'Pi Agent Interface' } },
    );
  if (path === '/v1/teams')
    return json(
      res,
      teamsOf(principal).map(({ owner, ...t }) => t),
    );

  if (path === '/v1/agent-templates')
    return json(
      res,
      principal.kind === 'service' ? [TEMPLATES.general] : [TEMPLATES.general, TEMPLATES.research],
    );
  if ((m = /^\/v1\/teams\/([^/]+)\/agent-templates$/.exec(path))) {
    const team = find(decodeURIComponent(m[1]));
    return json(res, team?.id === TEAM_ID ? [TEMPLATES.research] : []);
  }
  if ((m = /^\/v1\/teams\/([^/]+)\/models$/.exec(path)))
    return json(
      res,
      MODELS.map(({ id, name, enabled }) => ({ id, name, enabled })),
    );
  if ((m = /^\/v1\/teams\/([^/]+)\/limits$/.exec(path))) {
    const team = find(decodeURIComponent(m[1]));
    return json(res, {
      kind: team?.kind ?? 'team',
      maxAgents: team?.kind === 'personal' ? 10 : null,
      agentCount: [...agents.values()].filter((a) => a.team.id === team?.id).length,
    });
  }
  if ((m = /^\/v1\/teams\/([^/]+)\/usage$/.exec(path))) {
    const team = find(decodeURIComponent(m[1]));
    if (!team || !teamsOf(principal).some((t) => t.id === team.id))
      return fail(res, 404, 'not_found', 'Team not found');
    return json(res, { rows: usageFor(team, url.searchParams) });
  }

  // Agents.
  if (path === '/v1/agents/events' && method === 'GET') {
    sse(res);
    const sub = { principal, res, agentId: url.searchParams.get('agentId') };
    send(res, 'ready', {});
    if (url.searchParams.get('once') === 'true') return res.end();
    eventSubs.add(sub);
    req.on('close', () => eventSubs.delete(sub));
    return;
  }
  if (path === '/v1/agents' && method === 'GET') {
    const list = [...agents.values()].filter((a) => canUseAgent(principal, a));
    return json(res, list.map(agentView));
  }
  if ((m = /^\/v1\/teams\/([^/]+)\/agents$/.exec(path)) && method === 'POST') {
    const team = find(decodeURIComponent(m[1]));
    if (!team || !teamsOf(principal).some((t) => t.id === team.id))
      return fail(res, 404, 'not_found', 'Team not found');
    const body = parseJson(await readBody(req));
    const name = String(body.name ?? '').trim();
    if (
      [...agents.values()].some(
        (a) => a.team.id === team.id && a.name.toLowerCase() === name.toLowerCase(),
      )
    )
      return fail(res, 409, 'name_taken', 'Agent names are unique in a workspace.');
    const template =
      Object.values(TEMPLATES).find((t) => t.id === body.templateId) ?? TEMPLATES.general;
    const model = MODELS.find((x) => x.id === body.modelId) ?? null;
    const agent = makeAgent({
      team,
      name,
      description: String(body.description ?? ''),
      template,
      model,
    });
    return json(res, agentView(agent), 201);
  }
  if ((m = /^\/v1\/teams\/([^/]+)\/agents\/by-key\/([^/]+)$/.exec(path)) && method === 'PUT') {
    const team = find(decodeURIComponent(m[1]));
    if (!team || team.id !== TEAM_ID || principal.kind !== 'service')
      return fail(res, 404, 'not_found', 'Team not found');
    const key = decodeURIComponent(m[2]);
    const body = parseJson(await readBody(req));
    const existing = [...agents.values()].find(
      (a) => a.team.id === team.id && a.externalKey === key,
    );
    if (existing) return json(res, agentView(existing));
    const template =
      Object.values(TEMPLATES).find((t) => t.id === body.templateId) ?? TEMPLATES.general;
    const model = MODELS.find((x) => x.id === body.modelId) ?? null;
    const agent = makeAgent({
      team,
      name: body.name ?? key,
      description: body.description ?? '',
      template,
      model,
      externalKey: key,
    });
    return json(res, agentView(agent), 201);
  }
  if ((m = /^\/v1\/agents\/([^/]+)$/.exec(path))) {
    const agent = agents.get(m[1]);
    if (!agent || !canUseAgent(principal, agent))
      return fail(res, 404, 'not_found', 'Agent not found');
    if (method === 'GET') return json(res, agentView(agent));
    if (method === 'DELETE') {
      agents.delete(agent.id);
      threads.delete(agent.id);
      return json(res, { ok: true });
    }
    if (method === 'PATCH') {
      if (req.headers['if-match'] !== `"${agent.revision}"`)
        return fail(res, 412, 'precondition_failed', 'The agent changed.');
      const body = parseJson(await readBody(req));
      if (typeof body.name === 'string') agent.name = body.name;
      if (typeof body.description === 'string') agent.description = body.description;
      if (body.modelId) agent.model = MODELS.find((x) => x.id === body.modelId) ?? agent.model;
      agent.revision += 1;
      agent.updatedAt = Date.now();
      return json(res, agentView(agent));
    }
  }

  // Threads.
  if (
    (m = /^\/v1\/agents\/([^/]+)\/threads(?:\/([^/]+)(?:\/(messages|stop|events))?)?$/.exec(path))
  ) {
    const agent = agents.get(m[1]);
    if (!agent || !canUseAgent(principal, agent))
      return fail(res, 404, 'not_found', 'Agent not found');
    const map = threads.get(agent.id);
    const threadId = m[2];
    const sub = m[3];
    if (!threadId && method === 'GET') {
      const list = [...map.values()]
        .filter((t) => visibleThread(principal, t))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return json(res, list.map(threadView));
    }
    let t = map.get(threadId);
    if (t && !visibleThread(principal, t)) t = undefined;
    if (sub === 'messages' && method === 'POST') {
      const body = parseJson(await readBody(req));
      const text = String(body.text ?? '').trim();
      if (!text) return fail(res, 400, 'invalid', 'text is required');
      if (!t) {
        const owner = principal.kind === 'user' ? principal.email : 'service';
        const person = personByEmail(owner);
        t = addThread(agent, owner, {
          threadId,
          title: text.replace(/\s+/g, ' ').slice(0, 60),
          createdAge: 0,
          updatedAge: 0,
          replyAge: null,
          messages: [],
        });
        t.createdBy = { kind: 'user', id: uuid(`user:${owner}`), name: person?.name ?? owner };
      }
      t.messages.push({ id: `e${t.messages.length + 1}`, role: 'user', text, at: Date.now() });
      t.updatedAt = Date.now();
      startReply(agent, t);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: { submissionId: ++counter } }));
    }
    if (!t) return fail(res, 404, 'thread_not_found', 'Conversation not found');
    if (sub === 'events' && method === 'GET') {
      sse(res);
      send(res, 'view', chatView(t));
      if (url.searchParams.get('once') === 'true') return res.end();
      const s = { principal, res, agentId: agent.id, threadId };
      threadSubs.add(s);
      req.on('close', () => threadSubs.delete(s));
      return;
    }
    if (sub === 'stop' && method === 'POST') {
      for (const id of timers.get(`${agent.id}/${threadId}`) ?? []) clearTimeout(id);
      if (t.busy) {
        t.messages.push({
          id: `e${t.messages.length + 1}`,
          role: 'assistant',
          text: t.partial?.text ?? '',
          error: 'Interrupted',
          stopReason: 'aborted',
          at: Date.now(),
        });
        t.busy = false;
        t.partial = null;
        t.tools = [];
        t.lastReplyAt = Date.now();
        emitThread(agent, t);
        emitView(agent, t);
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: { ok: true } }));
    }
    if (!sub && method === 'GET') return json(res, chatView(t));
    if (!sub && method === 'PATCH') {
      const body = parseJson(await readBody(req));
      if (typeof body.title === 'string' && body.title.trim()) t.title = body.title.trim();
      emitThread(agent, t);
      return json(res, threadView(t));
    }
    if (!sub && method === 'DELETE') {
      map.delete(threadId);
      emitThread(agent, t, true);
      return json(res, { ok: true });
    }
  }

  return fail(res, 404, 'not_found', 'Not found');
}

resetWorld();
const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[fake-platform]', error);
    if (!res.headersSent) fail(res, 500, 'internal', 'Internal error');
    else res.end();
  });
});
server.listen(PORT, '127.0.0.1', () =>
  console.log(
    `[fake-platform] ${BASE} (127.0.0.1:${PORT}), office zone ${OFFICE_ZONE}, service team ${SERVICE_TEAM}`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
