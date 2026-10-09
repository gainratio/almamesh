import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  useOnboardingStore,
  useProfilesStore,
  useChartLibraryStore,
  type Profile,
} from '@almamesh/store';
import { Button, Dialog, Input } from '../../ui';
import { AvatarChip } from './AvatarChip';
import { deleteProfileData } from '../../../lib/profileDataLifecycle';
import { useStagedPerson } from '../people/useStagedPerson';

/**
 * ProfileSwitcher — the header control for named, password-less people sharing
 * one device. Shows the active person's avatar + name; opens a dialog to switch
 * person, add a new one, rename, or delete (with confirm). Switching refreshes
 * the chart view (invalidates the `primary-chart` query) and routes to the
 * dashboard or onboarding depending on whether the new person has a chart.
 *
 * Local-first: no account, no login. Profile deletion goes through the lifecycle
 * coordinator so charts, chat, events, rectification, readings, predictive data,
 * mesh edges, and semantic-memory vectors disappear together.
 */
export function ProfileSwitcher() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation('common');

  // Select STABLE state slices (the record + the id) and derive the rest with
  // useMemo. Selecting `getActiveProfile()`/`listProfiles()` directly returns a
  // fresh object/array every render and loops forever under React 19 (#185).
  const profilesMap = useProfilesStore((s) => s.profiles);
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const renameProfile = useProfilesStore((s) => s.renameProfile);
  const setActiveProfile = useProfilesStore((s) => s.setActiveProfile);
  // The onboarding wizard reads a DIFFERENT store than this one; without the
  // hand-off in `handleAdd`, the wizard asks again for the name typed here.
  const setOnboardingName = useOnboardingStore((s) => s.setName);

  const profiles = useMemo(
    () => Object.values(profilesMap).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [profilesMap],
  );
  const activeProfile = activeProfileId ? profilesMap[activeProfileId] : undefined;
  // The last remaining person cannot be deleted — at least one must exist.
  const canDelete = profiles.length > 1;

  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Saving, retrying and cancelling a person whose save did not finish.
  const stagedPerson = useStagedPerson();

  /** Close the menu; a person whose save failed is rolled back with it. */
  const closeDialog = () => {
    stagedPerson.discard();
    setAddError(null);
    setOpen(false);
  };

  /** Refresh the chart view + route to the right place for `profileId`. */
  const refreshForProfile = (profileId: string | null) => {
    // The active scope is pushed into chartLibrary by the store; re-resolve the
    // primary chart and route accordingly.
    void queryClient.invalidateQueries({ queryKey: ['primary-chart'] });
    const hasChart = profileId != null && !!useChartLibraryStore.getState().getPrimaryChart();
    navigate(hasChart ? '/dashboard' : '/onboarding');
  };

  const handleSwitch = (id: string) => {
    // Roll back an unsaved add FIRST: it restores the previous active person,
    // which the switch below then overrides.
    closeDialog();
    setActiveProfile(id);
    refreshForProfile(id);
  };

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name || adding) {
      return;
    }
    setAddError(null);
    setAdding(true);
    let id: string;
    try {
      // Only move on once the person is on disk: navigating first let a full
      // page load lose them while the write was still queued. A retry re-saves
      // the same person under the current name, never a second copy.
      id = await stagedPerson.save({ name, relationship: undefined });
    } catch {
      setAddError(t('profiles.add_error'));
      return;
    } finally {
      setAdding(false);
    }
    setNewName('');
    // A brand-new person has no chart yet → send them to onboarding, with the
    // name already answered so the wizard never asks for it twice.
    setOnboardingName(name);
    setOpen(false);
    refreshForProfile(id);
  };

  const handleRenameCommitFor = (p: Profile) => {
    const name = renameValue.trim();
    if (name) {
      renameProfile(p.id, name);
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setDeleteError(null);
    try {
      await deleteProfileData(id);
      setConfirmDeleteId(null);
      const nextActive = useProfilesStore.getState().activeProfileId;
      refreshForProfile(nextActive);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('profiles.delete_error'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={
          activeProfile
            ? t('profiles.active_switch_aria', { name: activeProfile.name })
            : t('profiles.add_a_person')
        }
        className="inline-flex items-center gap-2 rounded-full border border-ui-border bg-background-elevated px-2 py-1 font-sans text-sm text-text-body transition-colors hover:border-ui-borderLight hover:bg-background-tertiary"
      >
        {activeProfile ? (
          <>
            <AvatarChip tint={activeProfile.avatarTint} name={activeProfile.name} />
            <span className="max-w-[5rem] truncate pr-1 sm:max-w-[8rem]">{activeProfile.name}</span>
          </>
        ) : (
          <>
            <span className="h-2 w-2 rounded-full bg-accent-gold" aria-hidden="true" />
            <span className="pr-1">{t('profiles.add_person')}</span>
          </>
        )}
      </button>

      <Dialog open={open} onClose={closeDialog} title={t('profiles.dialog_title')}>
        <div className="flex flex-col gap-4">
          <p className="font-sans text-sm text-text-secondary">
            {t('profiles.dialog_description')}
          </p>

          <ul className="flex flex-col gap-1.5" aria-label={t('profiles.people_list_aria')}>
            {profiles.map((p) => {
              const isActive = p.id === activeProfile?.id;
              const isRenaming = renamingId === p.id;
              const isConfirming = confirmDeleteId === p.id;
              return (
                <li
                  key={p.id}
                  className={`flex items-center gap-3 rounded-md border px-3 py-2 ${
                    isActive ? 'border-accent-gold/50 bg-accent-gold/5' : 'border-ui-border'
                  }`}
                >
                  <AvatarChip tint={p.avatarTint} name={p.name} />
                  {isRenaming ? (
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleRenameCommitFor(p);
                        }
                      }}
                      aria-label={t('profiles.rename_aria', { name: p.name })}
                      className="h-8 flex-1"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSwitch(p.id)}
                      className="flex-1 truncate text-left font-sans text-sm text-text-primary hover:text-accent-gold-bright"
                    >
                      {p.name}
                      {isActive && (
                        <span className="ml-2 font-sans text-xs text-text-muted">
                          {t('profiles.active_badge')}
                        </span>
                      )}
                    </button>
                  )}

                  {isConfirming ? (
                    <span className="flex flex-col items-end gap-1.5">
                      <span className="font-sans text-xs text-text-secondary">
                        {t('profiles.delete_confirm', { name: p.name })}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-status-error"
                          disabled={deletingId === p.id}
                          onClick={() => void handleDelete(p.id)}
                        >
                          {t('profiles.delete')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                          {t('actions.cancel')}
                        </Button>
                      </span>
                    </span>
                  ) : isRenaming ? (
                    <Button size="sm" variant="ghost" onClick={() => handleRenameCommitFor(p)}>
                      {t('actions.save')}
                    </Button>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('profiles.rename_aria', { name: p.name })}
                        onClick={() => {
                          setRenamingId(p.id);
                          setRenameValue(p.name);
                        }}
                      >
                        {t('profiles.rename')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('profiles.delete_aria', { name: p.name })}
                        className="text-text-muted hover:text-status-error"
                        disabled={!canDelete}
                        title={canDelete ? undefined : t('profiles.last_person_hint')}
                        onClick={() => setConfirmDeleteId(p.id)}
                      >
                        {t('profiles.delete')}
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
            {profiles.length === 0 && (
              <li className="rounded-md border border-ui-border px-3 py-2 font-sans text-sm text-text-muted">
                {t('profiles.empty_state')}
              </li>
            )}
          </ul>

          {deleteError && <p className="font-sans text-sm text-status-error">{deleteError}</p>}
          {addError && (
            <p role="alert" className="font-sans text-sm text-status-error">
              {addError}
            </p>
          )}

          <div className="flex items-end gap-2 border-t border-ui-border pt-4">
            <label className="flex-1">
              <span className="mb-1 block font-sans text-xs text-text-muted">
                {t('profiles.add_a_person')}
              </span>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleAdd();
                  }
                }}
                placeholder={t('profiles.name_placeholder')}
                aria-label={t('profiles.new_person_name_aria')}
              />
            </label>
            <Button
              variant="primary"
              onClick={() => void handleAdd()}
              disabled={!newName.trim() || adding}
            >
              {t('profiles.add')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
