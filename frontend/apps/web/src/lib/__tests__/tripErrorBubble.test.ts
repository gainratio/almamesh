// The trip matrix charges an error bubble only to the question whose turn produced it (Task 10e).
// Error bubbles stay in the thread, so reading the thread's last bubble charged one turn's error to
// every later question. The spec counts bubbles before the send and keeps only the ones added since.
import { describe, expect, it } from 'vitest';

import { turnErrorBubble } from '../../../e2e/answerChecks';

describe('turnErrorBubble', () => {
  it('is undefined when this turn added no bubble, even if an earlier turn left one', () => {
    expect(turnErrorBubble(1, ["Couldn't reach the AI"])).toBeUndefined();
  });

  it('is the bubble this turn added', () => {
    expect(turnErrorBubble(0, ['Rate limited'])).toBe('Rate limited');
    expect(turnErrorBubble(1, ["Couldn't reach the AI", 'Rate limited'])).toBe('Rate limited');
  });

  it('is the last of several bubbles this turn added', () => {
    expect(turnErrorBubble(1, ['old', 'first', 'second'])).toBe('second');
  });

  it('is undefined with no bubbles at all', () => {
    expect(turnErrorBubble(0, [])).toBeUndefined();
  });
});
