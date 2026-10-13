import { describe, expect, it } from 'vitest';

import {
  fuseByReciprocalRank,
  matchThreadTitles,
  RRF_K,
  SNIPPET_CHARS,
  snippetAround,
  type ChatSearchHit,
} from '../chatSearchFusion';

function message(id: string, thread = 't1', text = id): ChatSearchHit {
  return { source: 'message', message_id: id, thread_id: thread, text, score: 0.5 };
}

describe('reciprocal-rank fusion', () => {
  it('uses the standard k=60 constant', () => {
    expect(RRF_K).toBe(60);
  });

  it('ranks an item found by both lists above items found by one', () => {
    const vector = [message('m1'), message('m2'), message('m3')];
    const keyword = [message('m3'), message('m4')];
    const fused = fuseByReciprocalRank([vector, keyword], 10);
    // m3: 1/63 + 1/61; m1: 1/61; m2 and m4: 1/62 (tie keeps first appearance).
    expect(fused.map((hit) => hit.message_id)).toEqual(['m3', 'm1', 'm2', 'm4']);
  });

  it('counts each message once per list even when several chunks match', () => {
    const vector = [message('m1'), message('m1'), message('m2')];
    const keyword = [message('m2')];
    const fused = fuseByReciprocalRank([vector, keyword], 10);
    expect(fused.map((hit) => hit.message_id)).toEqual(['m2', 'm1']);
  });

  it('normalizes the fused score so rank 1 in every list is 100%', () => {
    const fused = fuseByReciprocalRank([[message('m1')], [message('m1')]], 10);
    expect(fused[0]?.score).toBeCloseTo(1);
    const single = fuseByReciprocalRank([[message('m1')], []], 10);
    expect(single[0]?.score).toBeCloseTo(0.5);
  });

  it('drops a thread-title hit when a message from that thread is already listed', () => {
    const title: ChatSearchHit = { source: 'thread', message_id: '', thread_id: 't1', text: '', score: 1 };
    const other: ChatSearchHit = { ...title, thread_id: 't2' };
    const fused = fuseByReciprocalRank([[message('m1', 't1')], [title, other]], 10);
    expect(fused.map((hit) => `${hit.source}:${hit.thread_id}`)).toEqual(['message:t1', 'thread:t2']);
  });

  it('keeps at most the requested number of hits', () => {
    const fused = fuseByReciprocalRank([[message('m1'), message('m2'), message('m3')]], 2);
    expect(fused).toHaveLength(2);
  });
});

describe('thread title matching', () => {
  const titles = [
    { thread_id: 'trip', profile_id: 'p1', text: '⏳ May 2019 · Singapore' },
    { thread_id: 'today', profile_id: 'p1', text: 'What about my career?' },
    { thread_id: 'other', profile_id: 'p2', text: '⏳ May 2019 · Singapore' },
  ];

  it('finds a trip thread by its place', () => {
    const hits = matchThreadTitles('Singapore', titles, 'p1');
    expect(hits.map((hit) => hit.thread_id)).toEqual(['trip']);
    expect(hits[0]?.source).toBe('thread');
  });

  it('finds a trip thread by its year and by a typed prefix, ignoring case and accents', () => {
    expect(matchThreadTitles('2019', titles, 'p1').map((hit) => hit.thread_id)).toEqual(['trip']);
    expect(matchThreadTitles('singa', titles, 'p1').map((hit) => hit.thread_id)).toEqual(['trip']);
    expect(matchThreadTitles('SÍNGAPORE', titles, 'p1').map((hit) => hit.thread_id)).toEqual(['trip']);
  });

  it('never returns another profile thread', () => {
    expect(matchThreadTitles('Singapore', titles, 'p2').map((hit) => hit.thread_id)).toEqual(['other']);
  });

  it('ranks the title matching more query terms first', () => {
    const hits = matchThreadTitles('may career', [
      ...titles,
      { thread_id: 'both', profile_id: 'p1', text: 'May career check' },
    ], 'p1');
    expect(hits.map((hit) => hit.thread_id)).toEqual(['both', 'trip', 'today']);
  });

  it('returns nothing for a blank or punctuation-only query', () => {
    expect(matchThreadTitles('  ', titles, 'p1')).toEqual([]);
    expect(matchThreadTitles('·', titles, 'p1')).toEqual([]);
  });
});

describe('keyword snippet', () => {
  it('returns a short message whole', () => {
    expect(snippetAround('Saturn slows your career.', 'career')).toBe('Saturn slows your career.');
  });

  it('centres a long message on the first matched term, keeping its accents', () => {
    const text = `${'Palabras de apertura. '.repeat(20)}Júpiter mejora tu carrera. ${'Cierre. '.repeat(40)}`;
    const snippet = snippetAround(text, 'jupiter');
    expect(snippet).toContain('Júpiter mejora tu carrera.');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2);
  });

  it('matches a typed prefix, and falls back to the start when nothing matches', () => {
    expect(snippetAround(`${'x '.repeat(200)}promotion`, 'promo')).toContain('promotion');
    expect(snippetAround(`opening ${'y '.repeat(200)}`, 'zzz').startsWith('opening')).toBe(true);
  });
});
