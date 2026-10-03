/**
 * Finish a legacy JSON import through the real fallback download UI.
 *
 * Legacy files have no password to reuse, so the user must provide one for the
 * encrypted pre-import safety copy. The anchor-download fallback cannot prove
 * that the file reached disk, which intentionally requires a second explicit
 * confirmation before Replace commits.
 */
export async function confirmLegacyBackupImport(
  page,
  safetyPassphrase = 'almamesh-test-safety-passphrase',
) {
  const confirm = page.getByTestId('backup-confirm-import')
  await confirm.waitFor({ state: 'visible' })
  await page.getByTestId('backup-safety-passphrase-input').fill(safetyPassphrase)

  const [safetyDownload] = await Promise.all([
    page.waitForEvent('download'),
    confirm.click(),
  ])
  await safetyDownload.cancel()

  await page.getByTestId('backup-safety-confirmation').waitFor({ state: 'visible' })
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    confirm.click(),
  ])
}
