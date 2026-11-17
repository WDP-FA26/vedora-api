describe('Process entrypoints (main & seed-cli)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it('bootstraps Nest application in main.ts', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const enableShutdownHooks = vi.fn();
    const get = vi.fn(() => ({ get: vi.fn(() => 4000) }));
    const fakeApp = { listen, enableShutdownHooks, get };

    vi.doMock('@nestjs/core', () => ({
      NestFactory: { create: vi.fn().mockResolvedValue(fakeApp) },
    }));
    vi.doMock('../../src/app.module.js', () => ({ AppModule: class {} }));
    vi.doMock('../../src/app.setup.js', () => ({ configureApp: vi.fn() }));
    vi.doMock('../../src/swagger.setup.js', () => ({ setupSwagger: vi.fn() }));

    await import('../../src/main.js');
    await new Promise((r) => setTimeout(r, 10));

    expect(enableShutdownHooks).toHaveBeenCalled();
    expect(listen).toHaveBeenCalledWith(4000, '0.0.0.0');
  });

  it('runs seed-cli.ts successfully and handles missing DATABASE_URL', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const seedDatabase = vi.fn().mockResolvedValue(undefined);
    const seedCatalog = vi.fn().mockResolvedValue(undefined);

    vi.stubEnv('DATABASE_URL', 'mongodb://localhost:27017/vedora');
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('mongoose', () => ({
      default: { createConnection: vi.fn(() => ({ close })) },
    }));
    vi.doMock('../../src/mongo/schemas/model-definitions.js', () => ({
      registerModels: vi.fn(),
    }));
    vi.doMock('../../src/mongo/mongo.service.js', () => ({
      MongoService: class {},
    }));
    vi.doMock('../../src/database/seed.js', () => ({ seedDatabase }));
    vi.doMock('../../src/database/seed-catalog.js', () => ({ seedCatalog }));

    await import('../../src/database/seed-cli.js');
    await new Promise((r) => setTimeout(r, 10));

    expect(seedDatabase).toHaveBeenCalled();
    expect(seedCatalog).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();

    vi.resetModules();
    vi.stubEnv('DATABASE_URL', '');
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('mongoose', () => ({
      default: { createConnection: vi.fn(() => ({ close })) },
    }));
    vi.doMock('../../../src/mongo/schemas/model-definitions.js', () => ({
      registerModels: vi.fn(),
    }));
    vi.doMock('../../../src/mongo/mongo.service.js', () => ({
      MongoService: class {},
    }));
    vi.doMock('../../../src/database/seed.js', () => ({ seedDatabase }));
    vi.doMock('../../../src/database/seed-catalog.js', () => ({ seedCatalog }));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../../../src/database/seed-cli.js');
    await new Promise((r) => setTimeout(r, 10));
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });
});
