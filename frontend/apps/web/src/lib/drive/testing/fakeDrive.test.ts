import { runBackupDriveContract } from './backupDriveContract';
import { createFakeDrive } from './fakeDrive';

runBackupDriveContract('fake drive', async () => createFakeDrive());
