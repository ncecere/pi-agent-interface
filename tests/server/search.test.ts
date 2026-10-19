// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  bodyOfView,
  MARK_END,
  MARK_START,
  matchesTerms,
  searchTerms,
  snippetOf,
  tapViews,
  tsQueryOf,
} from '../../server/search.ts';

describe('what is indexed', () => {
  it('is what people and the agent said, in order, not thinking, tool output or errors', () => {
    const body = bodyOfView({
      messages: [
        { role: 'user', text: 'Can I expense a standing desk?' },
        { role: 'tool', text: 'secret tool output' },
        { role: 'assistant', text: '  Yes, up to $400.  ' },
        { role: 'assistant', text: '' },
        { role: 'assistant' },
      ],
    });
    expect(body).toBe('Can I expense a standing desk?\nYes, up to $400.');
  });

  it('has a limit, and leaves out nothing it can keep before it', () => {
    const long = 'x'.repeat(150_000);
    const body = bodyOfView({
      messages: [
        { role: 'user', text: long },
        { role: 'assistant', text: long },
        { role: 'user', text: 'never reached' },
      ],
    });
    expect(body.length).toBeLessThanOrEqual(200_000);
    expect(body.startsWith('xxx')).toBe(true);
    expect(body).not.toContain('never reached');
    expect(bodyOfView({})).toBe('');
  });
});

describe('the words of a query', () => {
  it('are letters and digits, lower case, without punctuation or operators', () => {
    expect(searchTerms('Q3 Budget: "variance" & (cost)!')).toEqual([
      'q3',
      'budget',
      'variance',
      'cost',
    ]);
    expect(searchTerms("don't | drop; table--")).toEqual(['don', 't', 'drop', 'table']);
    expect(searchTerms('   ')).toEqual([]);
    expect(searchTerms('Überprüfung 東京')).toEqual(['überprüfung', '東京']);
  });

  it('are limited in number', () => {
    expect(searchTerms('a b c d e f g h i j k')).toHaveLength(8);
  });

  it('become a tsquery that cannot hold an operator', () => {
    expect(tsQueryOf(searchTerms("exp & !'x' | y:*"))).toBe('exp:* & x:* & y:*');
    expect(tsQueryOf([])).toBe('');
  });
});

describe('matching', () => {
  it('needs every word, each as the start of a word', () => {
    expect(matchesTerms('Can I expense a standing desk', ['expen', 'desk'])).toBe(true);
    expect(matchesTerms('Can I expense a standing desk', ['expen', 'chair'])).toBe(false);
    expect(matchesTerms('unexpensed', ['expen'])).toBe(false); // the start of a word, not anywhere in it
    expect(matchesTerms('anything', [])).toBe(false);
  });
});

describe('a snippet', () => {
  const mark = (s: string) => s.replaceAll(MARK_START, '[').replaceAll(MARK_END, ']');

  it('marks the matched words and shows what is around the first', () => {
    const body = `${'filler '.repeat(40)}The churn report for September lists the standing desks ${'tail '.repeat(40)}`;
    const out = mark(snippetOf(body, ['churn', 'desk']));
    expect(out).toContain('[churn] report');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(200);
  });

  it('marks the whole word that matched, for the start of a word', () => {
    expect(mark(snippetOf('Expenses and unexpensive things', ['expen']))).toBe(
      '[Expenses] and unexpensive things',
    );
  });

  it('is the start of the text when nothing matches, and never longer than asked', () => {
    expect(mark(snippetOf('short text', ['zzz']))).toBe('short text');
    expect(snippetOf('a'.repeat(1000), ['zzz'], 50).length).toBeLessThanOrEqual(52);
  });

  it('does not treat a word as a pattern', () => {
    expect(() => snippetOf('a (b) c', ['(b'])).not.toThrow();
    expect(mark(snippetOf('a.b c', ['.*']))).toBe('a.b c');
  });
});

describe('watching a stream', () => {
  const enc = new TextEncoder();
  const streamOf = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
  const drain = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const out: string[] = [];
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out.join('');
      out.push(decoder.decode(value, { stream: true }));
    }
  };

  it('hands each complete view on, wherever the bytes were cut, and passes every byte through', async () => {
    const view = JSON.stringify({ busy: false, messages: [{ role: 'user', text: 'héllo wörld' }] });
    const wire = `: keep-alive\n\nevent: ready\ndata: {}\n\nevent: view\ndata: ${view}\n\nevent: thread\ndata: {"x":1}\n\n`;
    // Cut it in awkward places, in the middle of a multi-byte character included.
    const bytes = enc.encode(wire);
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 7) chunks.push(bytes.slice(at, at + 7));
    const seen: unknown[] = [];
    let ended = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const out = await drain(
      tapViews(
        body,
        (v) => seen.push(v),
        () => ended++,
      ),
    );
    expect(out).toBe(wire);
    expect(seen).toEqual([JSON.parse(view)]);
    expect(ended).toBe(1);
  });

  it('ignores what is not a view, and what is not JSON, without harming the stream', async () => {
    const seen: unknown[] = [];
    const wire =
      'event: view\ndata: not json\n\nevent: view\ndata: {"messages":[]}\n\nevent: other\ndata: {"messages":[1]}\n\n';
    const out = await drain(tapViews(streamOf([wire]), (v) => seen.push(v)));
    expect(out).toBe(wire);
    expect(seen).toEqual([{ messages: [] }]);
  });

  it('says when the reader walks away', async () => {
    let ended = 0;
    const open = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode('event: ready\ndata: {}\n\n'));
      },
    });
    const tapped = tapViews(
      open,
      () => undefined,
      () => ended++,
    );
    const reader = tapped.getReader();
    await reader.read();
    await reader.cancel();
    expect(ended).toBe(1);
  });
});
