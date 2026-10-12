import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestInfo } from '@playwright/test';
import { withWebKitProfileCleanup } from '../../e2e/webkitProfileCleanup';
import { test as profileFixture } from '../../e2e/webkitProfile';

const fixture = vi.hoisted(() => ({
  mkdtemp: vi.fn(), rm: vi.fn(), launch: vi.fn(), start: vi.fn(),
  finish: vi.fn(), watch: vi.fn(), close: vi.fn(), goto: vi.fn(), evaluate: vi.fn(),
}));
vi.mock('node:fs/promises', () => {
  const module = { mkdtemp: fixture.mkdtemp, rm: fixture.rm };
  return { ...module, default: module };
});
vi.mock('@playwright/test', () => {
  const module = {
    test: { extend: (definitions: unknown) => definitions },
    webkit: { launchPersistentContext: fixture.launch },
  };
  return { ...module, default: module };
});
vi.mock('../../e2e/webkitDiagnostics', () => ({ startWebKitDiagnostics: fixture.start }));

beforeEach(() => {
  vi.resetAllMocks();
  fixture.mkdtemp.mockResolvedValue('/synthetic/profile');
  fixture.rm.mockResolvedValue(undefined);
  fixture.finish.mockResolvedValue(undefined);
  fixture.close.mockResolvedValue(undefined);
  fixture.goto.mockResolvedValue(undefined);
  fixture.evaluate.mockResolvedValue(undefined);
  fixture.start.mockReturnValue({ logger: {}, watch: fixture.watch, finish: fixture.finish });
  fixture.launch.mockResolvedValue({ close: fixture.close, pages: () => [{ goto: fixture.goto, evaluate: fixture.evaluate }] });
});

describe('WebKit profile cleanup evidence retention', () => {
  it('retains diagnostics and removes the profile even if native context close rejects', async () => {
    const closeError = new Error('native context close failed');
    const order: string[] = [];
    const finish = vi.fn(async () => { order.push('diagnostics'); });
    const removeProfile = vi.fn(async () => { order.push('profile'); });
    const removeVideo = vi.fn(async () => { order.push('video'); });
    await expect(withWebKitProfileCleanup(async () => { order.push('journey'); }, [
      async () => { order.push('close'); throw closeError; }, finish, removeProfile, removeVideo,
    ])).rejects.toBe(closeError);
    expect(order).toEqual(['journey', 'close', 'diagnostics', 'profile', 'video']);
    expect(finish).toHaveBeenCalledOnce();
    expect(removeProfile).toHaveBeenCalledOnce();
    expect(removeVideo).toHaveBeenCalledOnce();
  });

  it('preserves the original journey failure over close, diagnostics and removal failures', async () => {
    const original = new Error('original assertion');
    const close = vi.fn(async () => { throw new Error('context close'); });
    const finish = vi.fn(async () => { throw new Error('RSS write'); });
    const removeProfile = vi.fn(async () => { throw new Error('profile removal'); });
    const removeVideo = vi.fn(async () => undefined);
    await expect(withWebKitProfileCleanup(async () => { throw original; }, [close, finish, removeProfile, removeVideo])).rejects.toBe(original);
    for (const step of [close, finish, removeProfile, removeVideo]) expect(step).toHaveBeenCalledOnce();
  });

  it('preserves close error precedence when RSS retention also fails and still removes the profile', async () => {
    const closeError = new Error('original close failure');
    const finish = vi.fn(async () => { throw new Error('RSS failure'); });
    const removeProfile = vi.fn(async () => undefined);
    await expect(withWebKitProfileCleanup(async () => undefined, [
      async () => { throw closeError; }, finish, removeProfile,
    ])).rejects.toBe(closeError);
    expect(finish).toHaveBeenCalledOnce();
    expect(removeProfile).toHaveBeenCalledOnce();
  });

  it('preserves an RSS failure when close succeeds, while attempting later removals', async () => {
    const rssError = new Error('original RSS failure');
    const removeProfile = vi.fn(async () => { throw new Error('profile failure'); });
    const removeVideo = vi.fn(async () => undefined);
    await expect(withWebKitProfileCleanup(async () => undefined, [
      async () => undefined, async () => { throw rssError; }, removeProfile, removeVideo,
    ])).rejects.toBe(rssError);
    expect(removeProfile).toHaveBeenCalledOnce();
    expect(removeVideo).toHaveBeenCalledOnce();
  });

  it('awaits each cleanup in original order without detaching unhandled failures', async () => {
    let releaseClose!: () => void;
    let releaseFinish!: () => void;
    const close = new Promise<void>((resolve) => { releaseClose = resolve; });
    const finish = new Promise<void>((resolve) => { releaseFinish = resolve; });
    const order: string[] = [];
    const pending = withWebKitProfileCleanup(async () => { order.push('journey'); }, [
      async () => { order.push('close'); await close; },
      async () => { order.push('diagnostics'); await finish; },
      async () => { order.push('profile'); },
    ]);
    await vi.waitFor(() => expect(order).toEqual(['journey', 'close']));
    releaseClose();
    await vi.waitFor(() => expect(order).toEqual(['journey', 'close', 'diagnostics']));
    releaseFinish();
    await expect(pending).resolves.toBeUndefined();
    expect(order).toEqual(['journey', 'close', 'diagnostics', 'profile']);
  });

  it('preserves even an undefined thrown value while always completing cleanup', async () => {
    const removeProfile = vi.fn(async () => undefined);
    await expect(withWebKitProfileCleanup(async () => { throw undefined; }, [
      async () => { throw new Error('later failure'); }, removeProfile,
    ])).rejects.toBeUndefined();
    expect(removeProfile).toHaveBeenCalledOnce();
  });
});

describe('actual WebKit profile fixture cleanup', () => {
  type ContextFixture = (options: Record<string, unknown>, provide: (context: unknown) => Promise<void>, info: TestInfo) => Promise<void>;
  const contextFixture = (profileFixture as unknown as { context: ContextFixture }).context;
  const info = {
    status: 'passed', expectedStatus: 'passed', outputPath: (name: string) => `/synthetic/output/${name}`,
  } as unknown as TestInfo;
  const options = { browserName: 'webkit', contextOptions: {}, video: 'retain-on-failure' };

  it('always retains diagnostics and removes the profile when launch rejects', async () => {
    const original = new Error('native launch failure');
    fixture.launch.mockRejectedValueOnce(original);
    const provide = vi.fn(async () => undefined);
    await expect(contextFixture(options, provide, info)).rejects.toBe(original);
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.rm).toHaveBeenCalledExactlyOnceWith('/synthetic/profile', { recursive: true, force: true });
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.watch).not.toHaveBeenCalled();
    expect(provide).not.toHaveBeenCalled();
  });

  it('preserves the original launch error if diagnostic retention and profile removal also fail', async () => {
    const original = new Error('original native launch failure');
    fixture.launch.mockRejectedValueOnce(original);
    fixture.finish.mockRejectedValueOnce(new Error('diagnostic failure'));
    fixture.rm.mockRejectedValueOnce(new Error('profile removal failure'));
    await expect(contextFixture(options, async () => undefined, info)).rejects.toBe(original);
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.rm).toHaveBeenCalledOnce();
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it('closes an adopted context and retains diagnostics if watch fails before the journey', async () => {
    const original = new Error('watch registration failure');
    fixture.watch.mockImplementationOnce(() => { throw original; });
    const provide = vi.fn(async () => undefined);
    await expect(contextFixture(options, provide, info)).rejects.toBe(original);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.rm).toHaveBeenCalledExactlyOnceWith('/synthetic/profile', { recursive: true, force: true });
    expect(provide).not.toHaveBeenCalled();
    expect(fixture.goto).not.toHaveBeenCalled();
  });

  it('retains diagnostics/profile cleanup and the failure video after context close rejects', async () => {
    const original = new Error('native close failure');
    fixture.close.mockRejectedValueOnce(original);
    const provide = vi.fn(async () => undefined);
    await expect(contextFixture(options, provide, info)).rejects.toBe(original);
    expect(provide).toHaveBeenCalledOnce();
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.rm).toHaveBeenCalledExactlyOnceWith('/synthetic/profile', { recursive: true, force: true });
  });

  it('preserves origin-wipe failure and still attempts close, diagnostics and profile cleanup', async () => {
    const original = new Error('origin wipe failure');
    fixture.goto.mockRejectedValueOnce(original);
    fixture.close.mockRejectedValueOnce(new Error('later close failure'));
    const provide = vi.fn(async () => undefined);
    await expect(contextFixture(options, provide, info)).rejects.toBe(original);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.rm).toHaveBeenCalledExactlyOnceWith('/synthetic/profile', { recursive: true, force: true });
    expect(provide).not.toHaveBeenCalled();
  });

  it('keeps successful fixture behavior and removes retained video only after successful cleanup', async () => {
    const provide = vi.fn(async () => undefined);
    await expect(contextFixture(options, provide, info)).resolves.toBeUndefined();
    expect(fixture.launch).toHaveBeenCalledOnce();
    expect(fixture.watch).toHaveBeenCalledOnce();
    expect(provide).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.rm.mock.calls).toEqual([
      ['/synthetic/profile', { recursive: true, force: true }],
      ['/synthetic/output/video', { recursive: true, force: true }],
    ]);
  });

  it('keeps non-WebKit contexts on the existing path without profile or diagnostic work', async () => {
    const context = {};
    const provide = vi.fn(async () => undefined);
    await contextFixture({ ...options, browserName: 'chromium', context }, provide, info);
    expect(provide).toHaveBeenCalledExactlyOnceWith(context);
    for (const step of [fixture.mkdtemp, fixture.launch, fixture.start, fixture.close, fixture.finish, fixture.rm]) expect(step).not.toHaveBeenCalled();
  });
});
