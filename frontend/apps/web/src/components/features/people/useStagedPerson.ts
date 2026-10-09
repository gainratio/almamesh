/**
 * Add a person durably, with a retry and a clean cancel.
 *
 * The person is "staged" in memory while their SQLite write is in flight. If
 * the save fails or times out they stay staged so a retry re-saves the SAME
 * person (under the name now typed, never a second copy). If the user gives up
 * instead, `discard` removes them and gives focus back to whoever was active
 * before. The rollback is an ordinary write of the profiles row, so it queues
 * behind a write that is still pending: a late commit cannot bring them back.
 *
 * Shared by AddPersonDialog (Settings → People, /mesh) and the header
 * ProfileSwitcher.
 */
import { useRef } from 'react';
import { useProfilesStore } from '@almamesh/store';
import type { MemberRelationship } from '@almamesh/shared-types';
import { waitForStoreSaved } from '../../../lib/storeSaved';

export interface StagedPersonInput {
  readonly name: string;
  /** `undefined` clears any relationship a failed attempt set. */
  readonly relationship: MemberRelationship | undefined;
}

export interface StagedPerson {
  /** Stage (or re-stage) the person and resolve with their id once on disk. */
  readonly save: (input: StagedPersonInput) => Promise<string>;
  /** Roll back a person whose save did not finish. No-op when nothing is staged. */
  readonly discard: () => void;
}

interface Staged {
  readonly id: string;
  readonly previousActiveId: string | null;
}

/** Create the person, or on a retry bring the staged one up to date. */
function stage(current: Staged | null, input: StagedPersonInput): Staged {
  const store = useProfilesStore.getState();
  const staged = current ?? {
    previousActiveId: store.activeProfileId,
    id: store.createProfile(input.name),
  };
  if (current !== null) store.renameProfile(staged.id, input.name);
  if (input.relationship !== undefined) {
    store.setRelationship(staged.id, input.relationship);
  } else if (store.profiles[staged.id]?.relationship !== undefined) {
    store.clearRelationship(staged.id);
  }
  // Always queues a fresh write of the whole row, which is what a retry needs.
  store.setActiveProfile(staged.id);
  return staged;
}

export function useStagedPerson(): StagedPerson {
  const stagedRef = useRef<Staged | null>(null);

  const save = async (input: StagedPersonInput): Promise<string> => {
    const staged = stage(stagedRef.current, input);
    stagedRef.current = staged;
    await waitForStoreSaved('people');
    stagedRef.current = null;
    return staged.id;
  };

  const discard = (): void => {
    const staged = stagedRef.current;
    if (staged === null) return;
    stagedRef.current = null;
    useProfilesStore.getState().discardUnsavedProfile(staged.id, staged.previousActiveId);
  };

  return { save, discard };
}
