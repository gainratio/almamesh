/**
 * AddPersonDialog — the one shared "add a person" surface. Settings → People
 * and the /mesh constellation both open it in place.
 *
 * Submission REUSES the existing profile-creation + onboarding flow (create →
 * assign relationship → activate → refresh the primary-chart query →
 * /onboarding, exactly like the header ProfileSwitcher); the relationship is
 * assigned around it — chart creation is never forked.
 */

import { useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOnboardingStore, useProfilesStore } from '@almamesh/store';
import { safeError } from '@almamesh/shared-types';
import { MEMBER_RELATIONSHIPS, type MemberRelationship } from '@almamesh/shared-types';
import { Button, Dialog, Input, Select } from '../../ui';
import { waitForProfilesSaved } from '../../../lib/profilesSaved';

/** Narrow a raw `<select>` value to a member relationship (no casts). */
export function asMemberRelationship(value: string): MemberRelationship | undefined {
  return MEMBER_RELATIONSHIPS.find((r) => r === value);
}

interface RelationshipOptionsProps {
  /** i18n `t` bound to the `settings` namespace. */
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}

/** The shared option list: "no relationship" + the backend-aligned values. */
export function RelationshipOptions({ t }: RelationshipOptionsProps): ReactElement {
  return (
    <>
      <option value="">{t('people.no_relationship')}</option>
      {MEMBER_RELATIONSHIPS.map((r) => (
        <option key={r} value={r}>
          {t(`people.relationships.${r}`)}
        </option>
      ))}
    </>
  );
}

export interface AddPersonDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/** Name + relationship; submission hands off to the existing onboarding flow. */
export function AddPersonDialog({ open, onClose }: AddPersonDialogProps): ReactElement {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createProfile = useProfilesStore((s) => s.createProfile);
  const setRelationship = useProfilesStore((s) => s.setRelationship);
  const setActiveProfile = useProfilesStore((s) => s.setActiveProfile);
  // The wizard reads a DIFFERENT store than the profiles store this dialog
  // writes to. Without this hand-off the very next screen asks for the name we
  // just took. See `handOffNameToWizard`.
  const setOnboardingName = useOnboardingStore((s) => s.setName);

  const [name, setName] = useState('');
  const [relationshipValue, setRelationshipValue] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The person created by a submit whose save failed. A retry re-saves them
  // instead of creating a second copy.
  const unsavedIdRef = useRef<string | null>(null);

  const resetForm = (): void => {
    setName('');
    setRelationshipValue('');
    setSubmitError(null);
    unsavedIdRef.current = null;
  };

  // Reset on ANY close (Cancel, Escape, overlay) so a cancelled entry never
  // lingers into the next open.
  const handleClose = (): void => {
    resetForm();
    onClose();
  };

  /** Create (or, on a retry, re-save) the person in memory; return their id. */
  const stagePerson = (trimmed: string): string => {
    const id = unsavedIdRef.current ?? createProfile(trimmed);
    unsavedIdRef.current = id;
    const memberRelationship = asMemberRelationship(relationshipValue);
    if (memberRelationship) {
      setRelationship(id, memberRelationship);
    }
    // Always queues a fresh write of the whole row, which is what a retry needs.
    setActiveProfile(id);
    return id;
  };

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || saving) {
      return;
    }
    setSubmitError(null);
    setSaving(true);
    try {
      stagePerson(trimmed);
      // The person is "added" only once they are on disk. Moving on before
      // this let a full page load lose them (the write was still queued).
      await waitForProfilesSaved();
    } catch (err) {
      // A store or disk failure must never silently close the dialog or
      // escape the click handler: keep the typed entry, show a retryable notice.
      safeError('people.add_failed', err);
      setSubmitError(t('people.add_failed'));
      return;
    } finally {
      setSaving(false);
    }
    handleClose();
    // Hand the name to the wizard's own store BEFORE navigating so step 1 is
    // already answered. Creating a person deliberately switches the active
    // profile, so the wizard is now about THIS person — carrying a half-typed
    // name over from a different one would be the bug, not this write.
    setOnboardingName(trimmed);
    void queryClient.invalidateQueries({ queryKey: ['primary-chart'] });
    navigate('/onboarding');
  };

  return (
    <Dialog open={open} onClose={handleClose} title={t('people.add_title')}>
      <div className="space-y-4">
        <div>
          <label
            htmlFor="add-person-name"
            className="mb-1 block text-sm font-medium text-text-secondary"
          >
            {t('people.add_name_label')}
          </label>
          <Input
            id="add-person-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('people.add_name_placeholder')}
          />
        </div>
        <div>
          <label
            htmlFor="add-person-relationship"
            className="mb-1 block text-sm font-medium text-text-secondary"
          >
            {t('people.add_relationship_label')}
          </label>
          <Select
            id="add-person-relationship"
            value={relationshipValue}
            onChange={(e) => setRelationshipValue(e.target.value)}
          >
            <RelationshipOptions t={t} />
          </Select>
        </div>
        <p className="text-xs text-text-muted">{t('people.add_hint')}</p>
        {submitError !== null && (
          <p role="alert" data-testid="add-person-error" className="text-sm text-status-error">
            {submitError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={handleClose}>
            {t('people.add_cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || saving}>
            {t('people.add_continue')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
