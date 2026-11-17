import { HealthController } from '../../../src/health/health.controller.js';
import type { MongoService } from '../../../src/mongo/mongo.service.js';

describe('HealthController', () => {
  it('returns liveness payload with ISO timestamp', () => {
    const mongo = { ping: vi.fn() } as unknown as MongoService;
    const controller = new HealthController(mongo);

    const res = controller.live();
    expect(res.status).toBe('ok');
    expect(Date.parse(res.timestamp)).not.toBeNaN();
  });

  it('pings MongoDB on readiness check and propagates failures', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const controller = new HealthController({
      ping,
    } as unknown as MongoService);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });

    ping.mockRejectedValueOnce(new Error('db down'));
    await expect(controller.ready()).rejects.toThrow('db down');
  });
});
