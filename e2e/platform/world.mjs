// The fictional world of the capture stack: Example Corp, its people, the agent platform's models and templates, and
// the canned conversations. Nothing here is real: names are invented, addresses are example.com, and the text of
// every conversation was written for these screenshots.
//
// Times are written as ages ("42 minutes ago") and turned into Unix milliseconds from an anchor (the moment the fake
// platform started, or was re-anchored), so the demo always looks like "now".
import { createHash } from 'node:crypto';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** A stable UUID from a string, so ids survive a restart of the fake platform. */
export function uuid(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The app's own id for a development account (server/session.ts userIdFor('dev', id)). */
export const appPersonId = (devId) =>
  createHash('sha256').update(`dev\n${devId}`).digest('hex').slice(0, 40);

// ── People ─────────────────────────────────────────────────────────────────────────────────

const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const named = (name, extra = {}) => {
  const [first, ...rest] = name.split(' ');
  const last = rest.join(' ');
  return { id: slug(first), name, email: `${slug(first)}.${slug(last)}@example.com`, ...extra };
};

/** `role`: what the app has them as (the seed makes them so through the app); `status`: suspended by an administrator. */
export const PEOPLE = [
  named('Morgan Lee', { role: 'admin', first: true }),
  named('Alex Morgan', { role: 'admin' }),
  named('Priya Shah'),
  named('Sam Ortiz', { role: 'admin' }),
  named('Jordan Lee', { status: 'suspended' }),
  named('Maria Garcia'),
  ...[
    'Avery Kim',
    'Noah Patel',
    'Elena Rossi',
    "Liam O'Brien",
    'Fatima Khan',
    'Diego Alvarez',
    'Hannah Müller',
    'Kenji Tanaka',
    'Olivia Brooks',
    'Ravi Menon',
    'Zoe Fischer',
    'Ethan Walker',
    'Amara Okafor',
    'Lucas Silva',
    'Grace Nguyen',
    'Mateo Torres',
    'Isla Campbell',
    'Omar Haddad',
    'Sofia Petrova',
    'Daniel Cho',
    'Nora Lindqvist',
    'Tariq Rahman',
    'Chloe Dubois',
    'Felix Wagner',
    'Leila Farah',
    'Henry Adams',
    'Mia Johansson',
    'Arjun Rao',
    'Ruth Cohen',
    'Victor Moreau',
    'Yara Nasser',
    'Owen Hughes',
    'Tessa Brandt',
    'Ines Costa',
  ].map((n) => named(n)),
];

export const personByEmail = (email) => PEOPLE.find((p) => p.email === String(email).toLowerCase());
export const personById = (id) => PEOPLE.find((p) => p.id === id);

/** Members of the shared team "Finance" (Connect: its agent sits beside their own). Sam is not: his screen has no team. */
export const FINANCE_MEMBERS = ['priya', 'maria', 'avery', 'noah', 'elena'];

/** Average requests a day by person in the service-mode team (the usage report): five people, and the hand-made agent. */
export const USAGE_WEIGHTS = {
  priya: 14,
  sam: 11,
  maria: 9,
  avery: 8,
  noah: 7,
};

// ── Models and templates ──────────────────────────────────────────────────────────────────────

export const TEAM_ID = uuid('team:example-corp');
export const FINANCE_ID = uuid('team:finance');

export const MODELS = [
  { id: uuid('model:chat'), name: 'Chat model', enabled: true, price: { in: 2.5, out: 10 } },
  { id: uuid('model:fast'), name: 'Fast model', enabled: true, price: { in: 0.4, out: 1.6 } },
];

export const TEMPLATES = {
  general: {
    id: uuid('template:assistant'),
    slug: 'assistant',
    name: 'General assistant',
    description: 'A helpful all-round assistant. Reads, writes and runs commands when asked.',
    teamId: null,
  },
  research: {
    id: uuid('template:research-assistant'),
    slug: 'research-assistant',
    name: 'Research assistant',
    description: 'Finds sources, reads them and summarises with references.',
    teamId: TEAM_ID,
  },
};

// ── Conversations ─────────────────────────────────────────────────────────────────────────────

const fmtTime = (ms, timeZone) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms);
const fmtDay = (ms, timeZone) =>
  new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(ms);
const iso = (ms, timeZone, offset) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
};

/**
 * The conversations of one person with one of their agents, as thread specs. `ctx.officeZone` is the zone of Example
 * Corp's office (the person's own), for the Tokyo answer.
 */
export function conversations(email, agentName, ctx) {
  const { anchor, officeZone } = ctx;
  const ago = (ms) => anchor - ms;
  let n = 0;
  const id = () => `e${++n}`;
  const u = (text, age) => ({ id: id(), role: 'user', text, at: ago(age) });
  const a = ({ text = '', thinking, calls, error, age, stop }) => ({
    id: id(),
    role: 'assistant',
    text,
    ...(thinking ? { thinking } : {}),
    ...(calls
      ? {
          toolCalls: calls.map((c) => ({
            ...c,
            startedAt: ago(age - 2_000),
            endedAt: ago(age - 6_000),
          })),
        }
      : {}),
    ...(error ? { error } : {}),
    at: ago(age),
    model: { provider: 'example', id: 'chat-model' },
    usage: { input: 2400, output: 380, cacheRead: 0, cacheWrite: 0, total: 2780 },
    stopReason: stop ?? (error ? 'error' : calls ? 'toolUse' : 'stop'),
  });
  const r = (callId, name, text, isError = false, age = 0) => ({
    id: id(),
    role: 'tool',
    toolCallId: callId,
    name,
    text,
    isError,
    at: ago(age),
  });
  const thread = (key, title, o) => {
    n = 0;
    return { threadId: `t-${key}`, title, ...o };
  };
  const simple = (key, title, q, answer, age, extra = {}) => {
    n = 0;
    return thread(key, title, {
      createdAge: age + 4 * MIN,
      updatedAge: age,
      replyAge: age,
      messages: [u(q, age + 3 * MIN), a({ text: answer, age: age + MIN })],
      ...extra,
    });
  };

  const out = [];
  const who = email;

  if (who === 'priya.shah@example.com' && agentName === 'Assistant') {
    // 1. The Tokyo conversation (docs: chat-conversation, chat-tool-steps): one tool step, reasoning around it.
    {
      n = 0;
      const t0 = ago(42 * MIN);
      const tokyo = fmtTime(t0, 'Asia/Tokyo');
      const home = fmtTime(t0, officeZone);
      const day = fmtDay(t0, 'Asia/Tokyo');
      const offsetHours = Math.round(
        (new Date(new Date(t0).toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })) -
          new Date(new Date(t0).toLocaleString('en-US', { timeZone: officeZone }))) /
          HOUR,
      );
      const abbr = new Intl.DateTimeFormat('en-US', { timeZone: officeZone, timeZoneName: 'short' })
        .formatToParts(t0)
        .find((p) => p.type === 'timeZoneName').value;
      const hh = (h) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
      // Tokyo = home + offset. Home 20:00 = Tokyo (20 + offset) mod 24.
      const row = (homeStart, note) =>
        `| ${hh(homeStart)}–${hh(homeStart + 1)} | ${hh(homeStart + offsetHours)}–${hh(homeStart + offsetHours + 1)} | ${note} |`;
      const best = 9 - offsetHours; // the home hour at which Tokyo is 09:00 (hh() wraps it into 0-23)
      out.push(
        thread('tokyo-call', 'Plan a call with the Tokyo office', {
          createdAge: 46 * MIN,
          updatedAge: 41 * MIN,
          replyAge: 41 * MIN,
          messages: [
            u(
              'Plan a call with our Tokyo office next week: what time is it there now, and which hours overlap with ours?',
              46 * MIN,
            ),
            a({
              thinking:
                'The user wants to schedule a call with the Tokyo office. To say what time it is there now I need the current time in Tokyo, and then I can compare it with their own working hours. Let me look it up instead of guessing the offset.',
              calls: [{ id: 'call_tz1', name: 'get_time', arguments: { timezone: 'Asia/Tokyo' } }],
              age: 45 * MIN,
            }),
            r(
              'call_tz1',
              'get_time',
              JSON.stringify({
                timezone: 'Asia/Tokyo',
                iso: iso(t0, 'Asia/Tokyo', '+09:00'),
                weekday: day,
                utc_offset: '+09:00',
                dst: false,
              }),
              false,
              44 * MIN,
            ),
            a({
              thinking: `Tokyo is on JST, UTC+9, with no daylight saving. The office here is on ${abbr}, so the difference is ${offsetHours} hours. With a 09:00–18:00 day in both offices there is no real overlap: the only workable calls sit at the edge of one person's day. I'll lay out the options and recommend the one that starts Tokyo's morning.`,
              text: `## Tokyo call: overlapping hours\n\nIt is **${tokyo} on ${day}** in Tokyo (JST, UTC+9) and **${home}** here (${abbr}): ${offsetHours} hours ahead. With 09:00–18:00 days in both offices, these slots work:\n\n| Your time | Tokyo time | Notes |\n|---|---|---|\n${row(best, 'Best option: their morning, your evening')}\n${row(best - 1, 'Fine for a short call')}\n${row(best - 12, 'Late evening in Tokyo; only if urgent')}\n\n- Propose **${hh(best)}–${hh(best + 1)} your time** on Tuesday or Wednesday.\n- Keep it to **30 minutes** and send notes afterwards.\n- Rotate the awkward slot every month so the burden is shared.`,
              age: 41 * MIN,
              stop: 'stop',
            }),
          ],
        }),
      );
    }

    // 2. The hero (website chat-inbox): reasoning, two tool steps, a table.
    out.push(
      thread('q3-budget', 'Q3 spend against budget', {
        createdAge: 2 * HOUR,
        updatedAge: 95 * MIN,
        replyAge: 95 * MIN,
        messages: [
          u('How did we do against budget in Q3? Put it in a table by department.', 2 * HOUR),
          a({
            thinking:
              'I need the actuals first. The finance folder should have the Q3 export; I will read it, then total it by department against the budget column.',
            calls: [{ id: 'call_q1', name: 'read', arguments: { path: 'finance/q3-actuals.csv' } }],
            age: 118 * MIN,
          }),
          r(
            'call_q1',
            'read',
            'department,budget,actual,notes\nEngineering,1620000,1588400,"hiring two months behind plan"\nSales,910000,946300,"customer summit travel"\nMarketing,560000,501900,""\nSupport,480000,447200,""\nOperations,430000,356200,"warehouse lease moved to Q4"\n',
            false,
            117 * MIN,
          ),
          a({
            thinking:
              'The file has everything. I will compute the variance per department with a script rather than by hand.',
            calls: [
              {
                id: 'call_q2',
                name: 'bash',
                arguments: {
                  command: 'python3 tools/variance.py finance/q3-actuals.csv --by department',
                },
              },
            ],
            age: 116 * MIN,
          }),
          r(
            'call_q2',
            'bash',
            'department     budget      actual     variance\nEngineering    1620000     1588400    -31600  (-2.0%)\nSales          910000      946300     +36300  (+4.0%)\nMarketing      560000      501900     -58100  (-10.4%)\nSupport        480000      447200     -32800  (-6.8%)\nOperations     430000      356200     -73800  (-17.2%)\nTOTAL          4000000     3840000    -160000 (-4.0%)\n',
            false,
            115 * MIN,
          ),
          a({
            text: "Q3 closed **4.0% under budget**: $3.84M spent against a $4.00M plan.\n\n| Department | Budget | Actual | Variance |\n|---|---:|---:|---:|\n| Engineering | $1,620,000 | $1,588,400 | −$31,600 (−2.0%) |\n| Sales | $910,000 | $946,300 | +$36,300 (+4.0%) |\n| Marketing | $560,000 | $501,900 | −$58,100 (−10.4%) |\n| Support | $480,000 | $447,200 | −$32,800 (−6.8%) |\n| Operations | $430,000 | $356,200 | −$73,800 (−17.2%) |\n| **Total** | **$4,000,000** | **$3,840,000** | **−$160,000 (−4.0%)** |\n\nSales is the only department over plan, mostly travel for the September customer summit. Operations' underspend is the warehouse lease, which moved to Q4, so expect it to reverse next quarter.",
            age: 95 * MIN,
            stop: 'stop',
          }),
        ],
      }),
    );

    // 3. Tool steps (website tool-steps): a command, a web search, JSON output, one failed step.
    out.push(
      thread('disk-filling', 'Why is the staging disk filling up?', {
        createdAge: 5 * HOUR + 10 * MIN,
        updatedAge: 5 * HOUR,
        replyAge: 5 * HOUR,
        messages: [
          u(
            'The staging database volume went from 40% to 85% in two days. What is eating the disk?',
            5 * HOUR + 10 * MIN,
          ),
          a({
            calls: [
              {
                id: 'call_d1',
                name: 'bash',
                arguments: { command: 'du -sh /var/lib/postgresql/data/* | sort -rh | head -3' },
              },
            ],
            age: 5 * HOUR + 8 * MIN,
          }),
          r(
            'call_d1',
            'bash',
            '118G\t/var/lib/postgresql/data/pg_wal\n41G\t/var/lib/postgresql/data/base\n6.2G\t/var/lib/postgresql/data/pg_replslot\n',
            false,
            5 * HOUR + 7 * MIN,
          ),
          a({
            calls: [
              {
                id: 'call_d2',
                name: 'read',
                arguments: { path: '/var/log/postgresql/archive.log' },
              },
              {
                id: 'call_d3',
                name: 'web_search',
                arguments: { query: 'postgres pg_wal growing unused replication slot' },
              },
            ],
            age: 5 * HOUR + 6 * MIN,
          }),
          r(
            'call_d2',
            'read',
            "ENOENT: no such file or directory, open '/var/log/postgresql/archive.log'",
            true,
            5 * HOUR + 5 * MIN,
          ),
          r(
            'call_d3',
            'web_search',
            JSON.stringify({
              title: 'Why pg_wal keeps growing',
              url: 'https://docs.example.org/postgres/wal-retention',
            }),
            false,
            5 * HOUR + 4 * MIN,
          ),
          a({
            text: 'The WAL directory is **118 GB of the 170 GB used**. That points to an inactive replication slot holding on to old segments, and `pg_replslot` is also unusually large (6.2 GB).\n\nCheck it with:\n\n```sql\nSELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag\nFROM pg_replication_slots;\n```\n\nIf a slot shows `active = f` and a lag near 100 GB, dropping it with `pg_drop_replication_slot(...)` will let the server recycle the WAL. I could not read the archive log (the file does not exist on staging), so I could not rule out an archiving problem as well.',
            age: 5 * HOUR,
            stop: 'stop',
          }),
        ],
      }),
    );

    // 4. Pinned.
    out.push(
      simple(
        'release-checklist',
        'Release checklist for v2.4',
        'Give me a release checklist for v2.4. We ship Thursday.',
        'Here is a checklist for Thursday:\n\n- [ ] Freeze `main` on Wednesday 17:00\n- [ ] Run the full regression suite and the upgrade test from v2.3\n- [ ] Update the changelog and the migration notes\n- [ ] Tag, build and sign the images\n- [ ] Smoke test on staging, then roll out to 10%, then 100%\n- [ ] Post the announcement in the product channel',
        3 * HOUR,
        { pinned: true },
      ),
    );

    // 5. Done (unread).
    out.push(
      simple(
        'expense-policy',
        'Can I expense a standing desk?',
        'Can I expense a standing desk for my home office?',
        'Yes. Under the home-office policy you can expense **one desk up to $600** once every three years, with a receipt. Chairs and monitors are covered separately. Submit it under "Equipment" with the category *Home office*.',
        12 * MIN,
        { unread: true },
      ),
    );

    // 6. Failed with a provider error.
    out.push(
      thread('churn-export', 'Export the churn report to CSV', {
        createdAge: 31 * MIN,
        updatedAge: 25 * MIN,
        replyAge: 25 * MIN,
        error:
          '429: {"error":{"code":"rate_limit_exceeded","message":"Too Many Requests: the model is over its limit, retry in 60s"}}',
        messages: [
          u('Export the churn report for September to CSV and email me the file.', 31 * MIN),
          a({
            text: '',
            age: 25 * MIN,
            error:
              '429: {"error":{"code":"rate_limit_exceeded","message":"Too Many Requests: the model is over its limit, retry in 60s"}}',
          }),
        ],
      }),
    );

    // 7. A turn that never got a reply.
    out.push(
      thread('no-reply', 'Rename the staging bucket', {
        createdAge: 2 * HOUR + 50 * MIN,
        updatedAge: 2 * HOUR + 47 * MIN,
        replyAge: null,
        noReply: true,
        messages: [
          u(
            'Rename the staging bucket from "stg-assets" to "staging-assets" and update the references.',
            2 * HOUR + 47 * MIN,
          ),
        ],
      }),
    );

    // Inbox rows, read.
    out.push(
      simple(
        'weekly-status',
        "Draft this week's status email",
        "Draft this week's status email for the leadership team. Wins: the new billing page shipped; blockers: the audit export is late.",
        '**Subject: Weekly status, week 42**\n\nHi all,\n\n**Shipped:** the new billing page is live for all customers.\n\n**At risk:** the audit export is a few days late; the data team is confirming a new date today.\n\n**Next week:** pricing page refresh, and the v2.4 release on Thursday.\n\nPriya',
        5 * HOUR + 40 * MIN,
      ),
      simple(
        'onboarding-list',
        'Onboarding checklist for new hires',
        'What should be on a new hire checklist for the first week?',
        'A first-week checklist:\n\n1. Laptop, accounts and badge on day one\n2. A buddy from the same team\n3. A 30-minute intro with each teammate\n4. A small first task that ships by Friday\n5. A check-in with the manager on Friday',
        2 * DAY + 3 * HOUR,
      ),
    );
    // Woke: a snooze that ended.
    out.push(
      simple(
        'offsite',
        'Reschedule the offsite',
        'Find two dates in November for the team offsite that avoid the quarter-end crunch.',
        'The best two windows are **Nov 12–13** and **Nov 19–20**: both avoid the close (Nov 3–6) and the US holiday week. I would hold the 12th now and release it if the 19th works better.',
        34 * MIN,
        { woke: true },
      ),
    );
    // Snoozed (2).
    out.push(
      simple(
        'okr-draft',
        'Quarterly OKR draft',
        'Turn these notes into three OKRs for Q4.',
        'Three draft OKRs for Q4:\n\n1. **Make onboarding faster** (KR: median time to first value under 2 days)\n2. **Cut support load** (KR: tickets per customer down 15%)\n3. **Ship the audit export** (KR: used by 20 customers)',
        6 * HOUR,
        {
          snoozed: { untilIn: 3 * HOUR, atAgo: 2 * HOUR },
        },
      ),
      simple(
        'invoice-q',
        'Vendor invoice question',
        'Is the Northwind invoice for $4,180 within the approved PO?',
        'The PO NW-2291 was approved for $4,500, so the invoice is within it with $320 left. I would still check that the hours match the statement of work.',
        28 * HOUR,
        {
          snoozed: { untilIn: 20 * HOUR, atAgo: 4 * HOUR },
        },
      ),
    );
    // Settled (2 here, 2 more with the HR agent).
    out.push(
      simple(
        'press-note',
        'Proofread the press note',
        'Proofread this press note and keep my tone.',
        'Three small fixes: "affect" should be "effect" in the second paragraph, the date in the dateline is missing the year, and the last sentence repeats "customers". Otherwise it reads well.',
        3 * DAY,
        { settled: 2 * DAY + 20 * HOUR },
      ),
      simple(
        'talking-points',
        'Talking points for the all-hands',
        'Give me five talking points for the all-hands on Thursday.',
        'Five points: 1. Q3 results in one sentence. 2. What shipped. 3. What is next. 4. How we are hiring. 5. Open questions.',
        4 * DAY,
        { settled: 3 * DAY + 20 * HOUR },
      ),
    );
    // Archived (2 here, 1 with the research agent).
    out.push(
      simple(
        'old-email',
        'Reply to the conference organisers',
        'Write a polite decline to the conference organisers.',
        'Dear organisers, thank you for the invitation. We are not able to speak this year, but we would be glad to be considered again for the spring programme.',
        9 * DAY,
        { archived: 8 * DAY },
      ),
    );
  }

  if (who === 'priya.shah@example.com' && agentName === 'HR Helper') {
    out.push(
      simple(
        'vacation',
        'How many vacation days do I have left?',
        'How many vacation days do I have left this year?',
        'You have **9 days** left for 2026: 25 allowed, 14 taken, and 2 booked for the week of December 22 (counted as taken). Unused days up to 5 carry over until March 31.',
        26 * HOUR,
      ),
      simple(
        'parental',
        'Parental leave: how do I apply?',
        'How do I apply for parental leave?',
        'Tell your manager first, then submit the **Leave request** form in the HR portal at least 8 weeks before the start date. HR confirms within 3 working days and sets up payroll.',
        6 * DAY,
        { settled: 5 * DAY + 20 * HOUR },
      ),
      simple(
        'enrolment',
        'When does open enrollment close?',
        'When does benefits open enrollment close?',
        'Open enrollment runs **November 1–15**. Changes take effect on January 1.',
        20 * DAY,
        { archived: 19 * DAY },
      ),
      simple(
        'holiday-cal',
        'Company holidays next year',
        'Which company holidays fall on weekdays next year?',
        'In 2027 there are nine company holidays, seven of which fall on a weekday. The two that fall on a weekend are observed on the nearest Friday.',
        7 * DAY,
        { settled: 6 * DAY + 20 * HOUR },
      ),
    );
  }

  if (who === 'priya.shah@example.com' && agentName === 'Research helper') {
    n = 0;
    out.push(
      thread('q3-files', 'Summarise the files in the Q3 folder', {
        createdAge: 4 * MIN + 30_000,
        updatedAge: 4 * MIN + 20_000,
        replyAge: null,
        busy: true,
        messages: [
          u('Read the files in docs/q3 and give me a short summary of each one.', 4 * MIN + 20_000),
          a({
            thinking: 'List the folder first so I know what there is to read.',
            calls: [{ id: 'call_l1', name: 'bash', arguments: { command: 'ls -1 docs/q3' } }],
            age: 4 * MIN,
          }),
          r(
            'call_l1',
            'bash',
            'customer-interviews.md\nmarket-sizing.md\npricing-experiment.md\nroadmap-review.md\n',
            false,
            3 * MIN + 50_000,
          ),
          a({
            thinking: 'Four files. I will read them one at a time and keep notes as I go.',
            calls: [
              {
                id: 'call_l2',
                name: 'read',
                arguments: { path: 'docs/q3/customer-interviews.md' },
              },
            ],
            age: 3 * MIN + 40_000,
          }),
          r(
            'call_l2',
            'read',
            '# Customer interviews, Q3\n\nTwelve interviews across three segments. Most common theme: setup takes too long.\n',
            false,
            3 * MIN + 20_000,
          ),
          a({
            thinking: 'Interviews are about slow setup. Next the market sizing.',
            calls: [
              { id: 'call_l3', name: 'read', arguments: { path: 'docs/q3/market-sizing.md' } },
            ],
            age: 3 * MIN + 10_000,
          }),
          r(
            'call_l3',
            'read',
            '# Market sizing\n\nBottom-up estimate: 41,000 reachable teams, median seat count 18.\n',
            false,
            2 * MIN + 40_000,
          ),
          a({
            thinking: 'Now the pricing experiment.',
            calls: [
              { id: 'call_l4', name: 'read', arguments: { path: 'docs/q3/pricing-experiment.md' } },
            ],
            age: 2 * MIN + 30_000,
          }),
          r(
            'call_l4',
            'read',
            '# Pricing experiment\n\nVariant B (annual discount shown first) converted 11% better over 3 weeks.\n',
            false,
            2 * MIN,
          ),
          a({
            thinking: 'Last one: the roadmap review.',
            calls: [
              { id: 'call_l5', name: 'read', arguments: { path: 'docs/q3/roadmap-review.md' } },
            ],
            age: 90_000,
          }),
        ],
        partial: {
          thinking: '',
          text: '',
        },
        tools: [
          {
            callId: 'call_l5',
            name: 'read',
            status: 'running',
            output:
              '# Roadmap review, Q3\n\n## Shipped\n- Billing page redesign\n- Single sign-on for the admin console\n\n## Slipped\n- Audit export (dependency on the data team)\n',
          },
        ],
      }),
    );
    out.push(
      simple(
        'vendor-compare',
        'Compare the two vendor contracts',
        'Compare the Northwind and Fabrikam contracts: term, price, exit clauses.',
        '| | Northwind | Fabrikam |\n|---|---|---|\n| Term | 24 months | 12 months, auto-renews |\n| Price | $4,500 / month | $5,100 / month |\n| Exit | 90 days notice | 30 days notice, fee in year one |\n\nNorthwind is cheaper but locks you in longer. Fabrikam is easier to leave.',
        6 * HOUR,
      ),
      simple(
        'retention-lit',
        'Papers on async onboarding',
        'Find three papers on asynchronous onboarding and retention.',
        'Three starting points: *Remote onboarding and new-hire retention* (2023), *Async-first teams: a field study* (2024), and *The first 90 days, remote* (2022). I can summarise any of them.',
        30 * HOUR,
      ),
      simple(
        'market-notes',
        'Notes on the EU market',
        'Summarise what we know about the EU market.',
        'Three points: demand is strongest in Germany and the Netherlands, data residency is the main objection, and local resellers matter more than direct sales.',
        15 * DAY,
        { archived: 14 * DAY },
      ),
    );
  }

  if (who === 'priya.shah@example.com' && agentName === 'Close checklist') {
    out.push(
      simple(
        'oct-close',
        'October close: open items',
        'Which items are still open on the October close checklist?',
        'Four items are still open: **bank reconciliation** (waiting on the statement), **accrued expenses** (two vendors have not sent invoices), **payroll journal** and the **intercompany true-up**. Everything else is signed off.',
        2 * DAY + 2 * HOUR,
      ),
    );
  }

  if (who === 'sam.ortiz@example.com' && agentName === 'Assistant') {
    out.push(
      thread('churn-export', 'Export the churn report to CSV', {
        createdAge: 31 * MIN,
        updatedAge: 25 * MIN,
        replyAge: 25 * MIN,
        error:
          '429: {"error":{"code":"rate_limit_exceeded","message":"Too Many Requests: the model is over its limit, retry in 60s"}}',
        messages: [
          u('Export the churn report for September to CSV and email me the file.', 31 * MIN),
          a({
            text: '',
            age: 25 * MIN,
            error:
              '429: {"error":{"code":"rate_limit_exceeded","message":"Too Many Requests: the model is over its limit, retry in 60s"}}',
          }),
        ],
      }),
      simple(
        'standup',
        'Summarise yesterday’s standup',
        'Summarise the standup notes in three bullets.',
        '- The billing page is live\n- The audit export is blocked on the data team\n- Two interviews are scheduled for Thursday',
        3 * HOUR,
      ),
      simple(
        'ticket-triage',
        'Triage the open support tickets',
        'Which of these tickets need a reply today?',
        'Four of the nine need a reply today: the two about failed sign-ins, the refund request, and the question from the largest customer.',
        2 * DAY,
      ),
    );
  }

  // Everyone else who has an assistant gets a few ordinary conversations.
  if (
    out.length === 0 &&
    agentName === 'Assistant' &&
    ['alex.morgan@example.com', 'morgan.lee@example.com', 'maria.garcia@example.com'].includes(who)
  ) {
    out.push(
      simple(
        'welcome',
        'Getting started',
        'What can you help me with?',
        'I can read and write files, run commands, search the web and summarise what I find. Ask me to look into something and I will show my steps as I go.',
        2 * DAY,
      ),
      simple(
        'agenda',
        'Agenda for Monday’s review',
        'Draft an agenda for Monday’s product review.',
        '1. Metrics (10 min)\n2. Shipped since last review (10 min)\n3. Roadmap changes (15 min)\n4. Decisions needed (10 min)',
        26 * HOUR,
      ),
    );
  }

  return out;
}
