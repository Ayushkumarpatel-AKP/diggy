/**
 * Avatar-mapping tests — every agent state resolves to a real `@diggy/shared`
 * mood + state pair.
 */
import { describe, expect, it } from 'vitest';
import { STATE_TO_AVATAR, stateToAvatar } from '../src/index';
import type { AgentState } from '../src/index';

const STATES: readonly AgentState[] = [
  'thinking',
  'reading',
  'acting',
  'waiting-approval',
  'error',
  'done',
];

const MOODS = ['neutral', 'happy', 'sad', 'angry', 'relaxed', 'surprised', 'thinking'];
const AVATAR_STATES = ['idle', 'enter', 'exit', 'talk', 'listen', 'think', 'celebrate', 'sad'];

describe('stateToAvatar', () => {
  it('maps every agent state to a valid mood and avatar state', () => {
    for (const state of STATES) {
      const cue = stateToAvatar(state);
      expect(MOODS, `mood for ${state}`).toContain(cue.mood);
      expect(AVATAR_STATES, `state for ${state}`).toContain(cue.state);
      expect(STATE_TO_AVATAR[state]).toEqual(cue);
    }
  });

  it('covers every state exactly once (exhaustive record)', () => {
    expect(Object.keys(STATE_TO_AVATAR).sort()).toEqual([...STATES].sort());
  });

  it('uses the expected cue for each state', () => {
    expect(stateToAvatar('thinking')).toEqual({ mood: 'thinking', state: 'think' });
    expect(stateToAvatar('reading')).toEqual({ mood: 'relaxed', state: 'listen' });
    expect(stateToAvatar('acting')).toEqual({ mood: 'neutral', state: 'talk' });
    expect(stateToAvatar('waiting-approval')).toEqual({ mood: 'surprised', state: 'idle' });
    expect(stateToAvatar('error')).toEqual({ mood: 'sad', state: 'sad' });
    expect(stateToAvatar('done')).toEqual({ mood: 'happy', state: 'celebrate' });
  });

  it('falls back to thinking for an out-of-range state', () => {
    expect(stateToAvatar('browsing' as AgentState)).toEqual({ mood: 'thinking', state: 'think' });
  });
});
