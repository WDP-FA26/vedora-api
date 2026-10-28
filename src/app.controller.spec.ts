import { Test } from '@nestjs/testing';
import { AppController } from './app.controller.js';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();
    controller = moduleRef.get(AppController);
  });

  it('returns API information', () => {
    expect(controller.getInfo()).toEqual({
      name: 'Vedora API',
      version: '0.1.0',
      docs: '/docs',
    });
  });
});
