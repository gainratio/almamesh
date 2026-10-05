/**
 * Liveness for the dataset generation lease (see deletionTombstones.ts).
 *
 * A realm that takes the lease first takes a Web Lock named after the lease
 * owner and holds it until the lease settles. Web Locks are released by the
 * browser when a tab, worker or installed PWA window dies, so another realm
 * can tell a crashed owner from a slow one without waiting for a timeout.
 * Owners that hold a lock carry the `wl-` prefix in the ledger; any other
 * owner (no `navigator.locks`, or an older build) falls back to time expiry.
 */

export const RESTORE_LEASE_MS = 120_000;
const LOCK_PREFIX = 'almamesh-dataset-lease:';
const WEB_LOCK_OWNER_PREFIX = 'wl-';

interface HeldLock {
  readonly name?: string;
}

/** The slice of the Web Locks `LockManager` the lease needs. */
export interface DatasetLeaseLocks {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ readonly held?: readonly HeldLock[] }>;
}

/** The lease fields of the generation ledger. */
export interface DatasetLeaseState {
  readonly restoreInProgress: boolean;
  readonly restoreStartedAt?: number;
  readonly leaseOwner?: string;
}

let locksOverride: DatasetLeaseLocks | null | undefined;
const localOwners = new Set<string>();
const lockReleases = new Map<string, () => void>();

/** Test seam: `null` simulates a runtime without Web Locks. */
export function setDatasetLeaseLocksForTests(locks: DatasetLeaseLocks | null | undefined): void {
  locksOverride = locks;
}

function leaseLocks(): DatasetLeaseLocks | null {
  if (locksOverride !== undefined) return locksOverride;
  const locks = (globalThis.navigator as { locks?: Partial<DatasetLeaseLocks> } | undefined)
    ?.locks;
  return typeof locks?.request === 'function' && typeof locks.query === 'function'
    ? (locks as DatasetLeaseLocks)
    : null;
}

function lockName(owner: string): string {
  return `${LOCK_PREFIX}${owner}`;
}

async function holdLock(locks: DatasetLeaseLocks, owner: string): Promise<boolean> {
  try {
    await new Promise<void>((granted, failed) => {
      locks
        .request(
          lockName(owner),
          () =>
            new Promise<void>((release) => {
              lockReleases.set(owner, release);
              granted();
            }),
        )
        .catch(failed);
    });
    return true;
  } catch {
    // A sandboxed or opaque origin can refuse Web Locks; time expiry still applies.
    return false;
  }
}

/** Mint a lease owner for this realm, holding its liveness lock when possible. */
export async function createLeaseOwner(): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const locks = leaseLocks();
  const locked = locks !== null && (await holdLock(locks, `${WEB_LOCK_OWNER_PREFIX}${id}`));
  const owner = locked ? `${WEB_LOCK_OWNER_PREFIX}${id}` : id;
  localOwners.add(owner);
  return owner;
}

/** The lease settled (or was never written): drop the owner and its lock. */
export function releaseLeaseOwner(owner: string | undefined): void {
  if (owner === undefined) return;
  localOwners.delete(owner);
  lockReleases.get(owner)?.();
  lockReleases.delete(owner);
}

/** Whether `owner` is a lease this realm took and has not released. */
export function isLocalLeaseOwner(owner: string | undefined): boolean {
  return owner !== undefined && localOwners.has(owner);
}

/** Whether this realm currently holds any dataset lease. */
export function holdsAnyLease(): boolean {
  return localOwners.size > 0;
}

function timeExpired(lease: DatasetLeaseState, now: number): boolean {
  return lease.restoreStartedAt === undefined || lease.restoreStartedAt + RESTORE_LEASE_MS <= now;
}

/**
 * A lease is abandoned when its owner is dead: its Web Lock is no longer held,
 * or (without Web Locks) its time ran out. A lease without a start time is
 * expired. A lease whose owner lock is held is never abandoned, however old.
 */
export async function isLeaseAbandoned(lease: DatasetLeaseState): Promise<boolean> {
  if (!lease.restoreInProgress || isLocalLeaseOwner(lease.leaseOwner)) return false;
  const owner = lease.leaseOwner;
  const locks = leaseLocks();
  if (owner?.startsWith(WEB_LOCK_OWNER_PREFIX) === true && locks !== null) {
    const snapshot = await locks.query();
    return !(snapshot.held ?? []).some((lock) => lock.name === lockName(owner));
  }
  return timeExpired(lease, Date.now());
}

/**
 * Resolve when a live lease may have ended: the owner's lock is released, or
 * its time runs out. The caller re-reads the ledger and re-checks liveness.
 */
export function whenLeaseMayHaveEnded(lease: DatasetLeaseState): Promise<void> {
  const owner = lease.leaseOwner;
  const locks = leaseLocks();
  if (owner?.startsWith(WEB_LOCK_OWNER_PREFIX) === true && locks !== null) {
    return locks.request(lockName(owner), async () => undefined).then(() => undefined);
  }
  const delay = Math.max(0, (lease.restoreStartedAt ?? 0) + RESTORE_LEASE_MS - Date.now());
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(resolve, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** Test seam: forget every lease this realm took (a new page load). */
export function resetDatasetLeaseForTests(): void {
  for (const owner of [...localOwners]) releaseLeaseOwner(owner);
}
