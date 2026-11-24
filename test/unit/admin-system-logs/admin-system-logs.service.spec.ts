import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';
import { vi } from 'vitest';
import {
  AdminSystemLogsService,
  type SystemLogInput,
} from '../../../src/admin-system-logs/admin-system-logs.service.js';
import type { SystemLog } from '../../../src/mongo/models.js';
import { runtimeConfig } from '../../../src/config/runtime-config.js';

describe('Bounded history writes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('releases a successful request when storage hangs and tolerates a late rejection', async () => {
    vi.useFakeTimers();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    let rejectWrite!: (error: Error) => void;
    const pending = new Promise((_, reject) => {
      rejectWrite = reject;
    });
    const create = vi.fn().mockReturnValue(pending);
    const service = new AdminSystemLogsService({
      create,
    } as unknown as Model<SystemLog>);
    const input = {
      requestId: 'fixture-id',
      action: 'POST /admin/ingredients',
    } as SystemLogInput;
    const result = service.append(input);
    await vi.advanceTimersByTimeAsync(
      runtimeConfig.SYSTEM_LOG_WRITE_TIMEOUT_MS,
    );
    await expect(result).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'System log write failed; requestId=fixture-id; action=POST /admin/ingredients',
    );
    rejectWrite(new Error('secret-storage-detail'));
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears the deadline after a normal write', async () => {
    vi.useFakeTimers();
    const service = new AdminSystemLogsService({
      create: vi.fn().mockResolvedValue({}),
    } as unknown as Model<SystemLog>);
    await service.append({} as SystemLogInput);
    expect(vi.getTimerCount()).toBe(0);
  });
});
