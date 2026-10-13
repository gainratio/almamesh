/**
 * What a chat page hands the panel about each thread (plan 2026-10-13): the tools
 * registered for it, bound to its trip, and the trip's context for the card.
 * Built from the SAME builders a live turn uses (chatToolset.ts, tripContext.ts),
 * so the Tools list, the card and the model's request agree.
 */
import type { AgentTool } from '@almamesh/llm';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { viewerTodayDay } from './chatAgentTools';
import { buildChatToolset, type BuildChatToolsetInput } from './chatToolset';
import { tripContext, type TripContext } from './tripContext';

export interface ChatTripKit {
  readonly toolsFor: (asOf: ChatThreadAsOf | undefined) => readonly AgentTool[];
  readonly tripFor: (asOf: ChatThreadAsOf) => TripContext | undefined;
}

/** A live turn always carries a movement recorder, so the listing registers time_travel too. */
const LISTING_RECORDER = () => undefined;

export function chatTripKit(input: Omit<BuildChatToolsetInput, 'onTravel' | 'pinned'>): ChatTripKit {
  return {
    toolsFor: (asOf) => buildChatToolset({ ...input, onTravel: LISTING_RECORDER, ...(asOf ? { pinned: asOf } : {}) }).tools,
    tripFor: (asOf) => tripContext({
      chart: input.chart,
      asOf,
      today: viewerTodayDay(new Date()),
      birth: input.birth,
      language: input.language ?? 'en',
    }),
  };
}
