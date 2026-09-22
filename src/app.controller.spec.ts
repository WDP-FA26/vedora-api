import { AppController } from './app.controller';

describe('AppController', () => {
  it('returns API information', () => {
    const controller = new AppController();
    expect(controller.getInfo()).toEqual({
      name: 'Vedora API',
      version: '0.1.0',
      docs: '/docs',
    });
  });
});
