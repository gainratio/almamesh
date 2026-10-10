import { describe, expect, it } from 'vitest';
import type { DriveBackupEntry } from './backupDrive';
import { buildBackupName, parseBackupName } from './backupName';
import { KEEP_PER_DEVICE, planPrune } from './retention';

const UA = 'Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Safari/537.36';
function entry(id: string, minute: number, code: string): DriveBackupEntry {
  const name = buildBackupName(new Date(Date.UTC(2026, 9, 10, 12, minute)), UA, code);
  return { id, name, meta: parseBackupName(name.value)!, sizeBytes: 1 };
}

describe('planPrune', () => {
  it('pins the documented limit', () => {
    expect(KEEP_PER_DEVICE).toBe(10);
  });

  it('keeps the 10 newest of this device and trashes the rest, oldest first', () => {
    const mine = Array.from({ length: 13 }, (_, i) => entry(`m${i}`, i, 'aaaaaa'));
    expect(planPrune(mine, 'aaaaaa', 'm12')).toEqual(['m0', 'm1', 'm2']);
  });

  it('never selects another device', () => {
    const others = Array.from({ length: 30 }, (_, i) => entry(`o${i}`, i, 'bbbbbb'));
    expect(planPrune([...others, entry('m', 59, 'aaaaaa')], 'aaaaaa', 'm')).toEqual([]);
  });

  it('keeps the just-uploaded file even when its clock is behind and it sorts outside the 10 newest', () => {
    const mine = Array.from({ length: 10 }, (_, i) => entry(`m${i}`, 30 + i, 'aaaaaa'));
    const late = entry('late', 0, 'aaaaaa');
    expect(planPrune([...mine, late], 'aaaaaa', 'late')).toEqual([]);
  });

  it('still prunes the genuinely old files around a clock-skewed just-uploaded file', () => {
    const mine = Array.from({ length: 12 }, (_, i) => entry(`m${i}`, 30 + i, 'aaaaaa'));
    const late = entry('late', 0, 'aaaaaa');
    // sorted newest first: m11..m2 kept, then m1, m0, late are beyond the limit
    expect(planPrune([...mine, late], 'aaaaaa', 'late')).toEqual(['m0', 'm1']);
  });

  it('with 11 same-device files, trashes only the oldest and keeps the just-uploaded one', () => {
    const mine = Array.from({ length: 11 }, (_, i) => entry(`m${i}`, i, 'aaaaaa'));
    expect(planPrune(mine, 'aaaaaa', 'm9')).toEqual(['m0']);
  });
});
