import { test, expect, type Page } from '@playwright/test';

/**
 * A person added on /mesh must survive an immediate full page load.
 *
 * The bug this guards: "Add a person" updated the profiles store in memory and
 * navigated on at once, while the SQLite (OPFS) write was still queued. A user
 * who then loaded a URL straight away (typed it, refreshed, followed a link
 * that reloads) lost the person. Waiting a few seconds hid the bug, so the
 * journey below never waits: it adds the person and calls `page.goto` at once.
 *
 * Setup stays inside one page session (client-side navigation only), so no
 * earlier step can be lost the same way and mask the step under test.
 */

async function addPersonInDialog(page: Page, name: string, relationship?: string): Promise<void> {
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (relationship !== undefined) {
    await page.getByLabel('Relationship to you', { exact: true }).selectOption(relationship);
  }
  await page.getByRole('button', { name: 'Add & enter birth details' }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}

/** Build anchor + one member through the real UI, ending on the /mesh constellation. */
async function reachConstellation(page: Page): Promise<void> {
  await page.goto('/mesh');
  await page.getByTestId('mesh-invitation-cta').click();
  await addPersonInDialog(page, 'Asha Rao');
  await page.goBack();
  await page.getByTestId('mesh-invitation-manage-link').click();
  await expect(page).toHaveURL(/\/settings\/people/);
  await page.getByRole('button', { name: 'This is me' }).click();
  await page.getByRole('button', { name: 'Add a person' }).click();
  await addPersonInDialog(page, 'First Friend', 'friend');
  await page.goBack();
  await page.goBack();
  await expect(page.getByTestId('mesh-constellation')).toContainText('First Friend');
}

test('a person added on /mesh is still there after an immediate full page load', async ({
  page,
}) => {
  await reachConstellation(page);

  await page.getByTestId('mesh-node-add').click();
  await addPersonInDialog(page, 'Second Friend', 'friend');
  // No wait of any kind: the user loads a URL the moment the add returns.
  await page.goto('/mesh');

  await expect(page.getByTestId('mesh-page')).toBeVisible();
  await expect(page.getByTestId('mesh-constellation')).toContainText('First Friend');
  await expect(page.getByTestId('mesh-constellation')).toContainText('Second Friend');
});
