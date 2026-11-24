import { parseRuntimeSettings } from '@src/config/runtime-settings.js';

describe('Admin work queue operational bounds', () => {
  it('preserves the intended defaults and accepts explicit limits', () => {
    expect(parseRuntimeSettings({})).toMatchObject({
      ADMIN_WORK_PREVIEW_LIMIT: 10,
      ADMIN_WORK_REFRESH_SECONDS: 30,
      ADMIN_WORK_QUERY_TIMEOUT_MS: 5000,
      ADMIN_WORK_TITLE_MAX_LENGTH: 120,
    });
    expect(
      parseRuntimeSettings({
        ADMIN_WORK_PREVIEW_LIMIT: '20',
        ADMIN_WORK_REFRESH_SECONDS: '15',
      }),
    ).toMatchObject({
      ADMIN_WORK_PREVIEW_LIMIT: 20,
      ADMIN_WORK_REFRESH_SECONDS: 15,
    });
  });
  it.each([
    ['ADMIN_WORK_PREVIEW_LIMIT', '51'],
    ['ADMIN_WORK_PREVIEW_LIMIT', '0'],
    ['ADMIN_WORK_REFRESH_SECONDS', '1'],
    ['ADMIN_WORK_REFRESH_SECONDS', '3601'],
    ['ADMIN_WORK_QUERY_TIMEOUT_MS', '99'],
    ['ADMIN_WORK_QUERY_TIMEOUT_MS', '30001'],
    ['ADMIN_WORK_TITLE_MAX_LENGTH', '9'],
    ['ADMIN_WORK_TITLE_MAX_LENGTH', '501'],
  ])('rejects unsafe %s=%s at startup', (key, value) => {
    expect(() => parseRuntimeSettings({ [key]: value })).toThrow(key);
  });
});
