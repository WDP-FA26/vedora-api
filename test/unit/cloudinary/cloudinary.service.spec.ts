import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { CloudinaryService } from '../../../src/cloudinary/cloudinary.service.js';

function createService(): CloudinaryService {
  const values: Record<string, string> = {
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'key',
    CLOUDINARY_API_SECRET: 'secret',
    CLOUDINARY_FOLDER: 'vedora',
  };
  const config = {
    get: (name: string, fallback?: unknown) => values[name] ?? fallback,
  } as unknown as ConfigService;
  return new CloudinaryService(config);
}

describe('CloudinaryService.signRecipeImageUpload', () => {
  it('signs an image upload restricted to image formats', () => {
    const { upload, url } = createService().signRecipeImageUpload();

    expect(upload.url).toBe(
      'https://api.cloudinary.com/v1_1/demo/image/upload',
    );
    expect(upload.fields.allowed_formats).toBe('jpg,jpeg,png,webp');
    expect(upload.fields.public_id).toMatch(/^vedora\/recipe-images\/.+/);
    expect(upload.fields.signature).toBeTruthy();
    expect(url).toBe(
      `https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/${upload.fields.public_id}`,
    );
  });
});
