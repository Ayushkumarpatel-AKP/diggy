/**
 * Agent state → avatar reaction.
 *
 * The act layer reports five coarse states while it works; the avatar
 * (`@diggy/shared`'s `AvatarMood` + `AvatarState`, driven by `packages/avatar`)
 * turns those into a face and a motion. This module is the single mapping, so a
 * new state is a compile error here rather than a silent default at the call
 * site.
 */
import type { AgentState, AvatarCue } from './types';

/**
 * Every {@link AgentState} and its cue. Exhaustive by construction: the `Record`
 * keyed by the union means adding a state without a cue fails to compile.
 *
 * - `thinking` → `thinking` mood, `think` motion (pondering).
 * - `reading` → `relaxed` mood, `listen` motion (observing the page).
 * - `acting` → `neutral` mood, `talk` motion (doing / narrating).
 * - `waiting-approval` → `surprised` mood, `idle` motion (paused on the user).
 * - `error` → `sad` mood, `sad` motion.
 * - `done` → `happy` mood, `celebrate` motion.
 */
export const STATE_TO_AVATAR: Readonly<Record<AgentState, AvatarCue>> = {
  thinking: { mood: 'thinking', state: 'think' },
  reading: { mood: 'relaxed', state: 'listen' },
  acting: { mood: 'neutral', state: 'talk' },
  'waiting-approval': { mood: 'surprised', state: 'idle' },
  error: { mood: 'sad', state: 'sad' },
  done: { mood: 'happy', state: 'celebrate' },
};

/**
 * Map an agent state to the avatar's mood + state.
 *
 * Total: an out-of-range value (e.g. a model hallucinated `"browsing"`) falls
 * back to the `thinking` cue instead of throwing.
 */
export function stateToAvatar(state: AgentState): AvatarCue {
  return STATE_TO_AVATAR[state] ?? STATE_TO_AVATAR.thinking;
}
