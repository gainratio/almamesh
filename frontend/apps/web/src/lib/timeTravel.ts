// W/src/lib/timeTravel.ts
/**
 * The one way to travel to a moment (spec "One code path for travel to a
 * moment"). The Dashboard sheet, the chat sheet and banner, and the chat tool
 * all call applyTravel / applyBackToToday, so the same input gives the same
 * `as_of` and the same saves.
 *
 * Order (plan ruling 1): check, then save the chat pin (AI on only), then set
 * the Dashboard moment. A failed save moves nothing and rethrows.
 * The Dashboard moment is view state: memory only, never persisted (Ruling 1).
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import { describeLlmStatus, endsBeforeBirthYear } from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';
import { chatAsOfProblem, useChartLibraryStore, useChatStore } from '@almamesh/store';

import { birthYearOf } from './periodChart';
import { repinThread, startPinnedThread, todayThread } from './timeTravelThreads';

export type TravelSource = 'dashboard-sheet' | 'chat-sheet' | 'chat-tool';
export interface TravelRequest { readonly asOf: ChatThreadAsOf; readonly source: TravelSource; }
/** 'new': always a new pinned thread. { id }: repin it if pinned, else a new pinned thread. 'latest': the thread chat shows. */
export type TravelThread = 'new' | 'latest' | { readonly id: string };
export interface TravelTarget { readonly profileId: string; readonly chartId: string | null; readonly thread: TravelThread; }
export interface TravelDeps { aiConfigured(): boolean; birthYear(chartId: string | null): number | undefined; }
export interface TravelOutcome { readonly threadId: string | undefined; }

export class TimeTravelRefusedError extends Error {
  constructor(readonly reason: 'malformed' | 'before_birth', detail: string) {
    super(`Time travel refused (${reason}): ${detail}`);
    this.name = 'TimeTravelRefusedError';
  }
}

interface TimeTravelState {
  readonly moments: Readonly<Record<string, ChatThreadAsOf>>;
  setMoment(profileId: string, asOf: ChatThreadAsOf | undefined): void;
}

export const useTimeTravelStore = create<TimeTravelState>((set) => ({
  moments: {},
  setMoment: (profileId, asOf) => set((state) => {
    const moments = { ...state.moments };
    if (asOf) moments[profileId] = asOf;
    else delete moments[profileId];
    return { moments };
  }),
}));

const DEFAULT_DEPS: TravelDeps = {
  aiConfigured: () => describeLlmStatus().configured,
  birthYear: (chartId) => birthYearOf(chartId
    ? (useChartLibraryStore.getState().getChart(chartId)?.birth_data as ProcessedBirthData | undefined)
    : undefined),
};

function check(asOf: ChatThreadAsOf, birthYear: number | undefined): void {
  const problem = chatAsOfProblem(asOf);
  if (problem) throw new TimeTravelRefusedError('malformed', problem);
  if (endsBeforeBirthYear(asOf, birthYear)) throw new TimeTravelRefusedError('before_birth', asOf.start);
}

function threadToMove(target: TravelTarget): string | undefined {
  if (target.thread === 'new') return undefined;
  const id = target.thread === 'latest'
    ? useChatStore.getState().listThreads(target.profileId)[0]?.id
    : target.thread.id;
  return id && useChatStore.getState().threads[id]?.as_of ? id : undefined;
}

async function pinChat(asOf: ChatThreadAsOf, target: TravelTarget): Promise<string> {
  const pinned = threadToMove(target);
  if (!pinned) return startPinnedThread(target.profileId, target.chartId, asOf);
  await repinThread(pinned, asOf);
  return pinned;
}

export async function applyTravel(request: TravelRequest, target: TravelTarget, deps: TravelDeps = DEFAULT_DEPS): Promise<TravelOutcome> {
  check(request.asOf, deps.birthYear(target.chartId));
  const threadId = deps.aiConfigured() ? await pinChat(request.asOf, target) : undefined;
  useTimeTravelStore.getState().setMoment(target.profileId, request.asOf);
  return { threadId };
}

export async function applyBackToToday(target: Omit<TravelTarget, 'thread'>, deps: TravelDeps = DEFAULT_DEPS): Promise<TravelOutcome> {
  const threadId = deps.aiConfigured() ? await todayThread(target.profileId, target.chartId) : undefined;
  useTimeTravelStore.getState().setMoment(target.profileId, undefined);
  return { threadId };
}

export interface TimeTravelController {
  readonly moment: ChatThreadAsOf | undefined;
  travel(request: TravelRequest): Promise<void>;
  backToToday(): Promise<void>;
}

/** The Dashboard's handle on the seam. Moves the profile's latest chat thread (plan ruling 2). */
export function useTimeTravel(profileId: string | null, chartId: string | null): TimeTravelController {
  const moment = useTimeTravelStore((s) => (profileId ? s.moments[profileId] : undefined));
  const travel = useCallback(async (request: TravelRequest) => {
    if (profileId) await applyTravel(request, { profileId, chartId, thread: 'latest' });
  }, [profileId, chartId]);
  const backToToday = useCallback(async () => {
    if (profileId) await applyBackToToday({ profileId, chartId });
  }, [profileId, chartId]);
  return { moment, travel, backToToday };
}
