import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudinaryService,
  STREAM_TRANSFORMATION,
  UPLOAD_CHUNK_BYTES,
} from '../../../src/cloudinary/cloudinary.service.js';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';

function createService(
  overrides: Record<string, unknown> = {},
): CloudinaryService {
  const values: Record<string, unknown> = {
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'key',
    CLOUDINARY_API_SECRET: 'secret',
    CLOUDINARY_FOLDER: 'vedora',
    CLOUDINARY_WEBHOOKS_ENABLED: false,
    ...overrides,
  };
  const config = {
    get: <T>(name: string, fallback?: T): T =>
      (name in values ? values[name] : fallback) as T,
  } as unknown as ConfigService;
  return new CloudinaryService(config);
}

describe('CloudinaryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('configuration', () => {
    it('reports configured when cloud name, key, and secret are set', () => {
      const service = createService();
      expect(service.configured).toBe(true);
      expect(service.require()).toBe(cloudinary);
    });

    it.each([
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ])('reports unconfigured and throws 503 when %s is empty', (missing) => {
      const service = createService({ [missing]: '' });
      expect(service.configured).toBe(false);
      expect(() => service.require()).toThrow(FeatureUnavailableException);
    });
  });

  describe('public IDs and URLs', () => {
    it('builds and parses video and caption public IDs using configured folder', () => {
      const service = createService({ CLOUDINARY_FOLDER: 'custom' });
      expect(service.videoPublicId('m-1')).toBe('custom/videos/m-1');
      expect(service.captionPrefix('m-1')).toBe('custom/captions/m-1/');
      expect(service.mediaIdOf('custom/videos/m-1')).toBe('m-1');
      expect(service.mediaIdOf('vedora/videos/m-1')).toBeNull();
      expect(service.mediaIdOf('custom/recipe-images/m-1')).toBeNull();
    });

    it('builds original, HLS, frame, and poster URLs', () => {
      const service = createService();
      expect(service.originalUrl('vedora/videos/m1')).toBe(
        'https://res.cloudinary.com/demo/video/upload/vedora/videos/m1',
      );
      expect(service.hlsUrl('vedora/videos/m1')).toBe(
        'https://res.cloudinary.com/demo/video/upload/sp_auto/vedora/videos/m1.m3u8',
      );
      expect(service.frameUrl('vedora/videos/m1', 12.34)).toBe(
        'https://res.cloudinary.com/demo/video/upload/so_12.3,w_1024,c_limit,f_jpg/vedora/videos/m1.jpg',
      );
      expect(service.posterUrl('vedora/videos/m1')).toBe(
        'https://res.cloudinary.com/demo/video/upload/so_0,q_auto/vedora/videos/m1.jpg',
      );
    });
  });

  describe('upload signing', () => {
    it('signs a video upload with eager HLS transformation', () => {
      const signed = createService().signVideoUpload('vedora/videos/abc');

      expect(signed.url).toBe(
        'https://api.cloudinary.com/v1_1/demo/video/upload',
      );
      expect(signed.chunkSize).toBe(UPLOAD_CHUNK_BYTES);
      expect(signed.fields).toMatchObject({
        public_id: 'vedora/videos/abc',
        asset_folder: 'vedora/videos',
        eager: STREAM_TRANSFORMATION,
        eager_async: 'true',
        overwrite: 'false',
        api_key: 'key',
      });
      expect(signed.fields.signature).toMatch(/^[0-9a-f]{40}$/);
      expect(Number(signed.fields.timestamp)).toBeGreaterThan(0);
    });

    it('signs a blog video upload and returns its delivery URL', () => {
      const { upload, url } = createService().signBlogVideoUpload();

      expect(upload.url).toBe(
        'https://api.cloudinary.com/v1_1/demo/video/upload',
      );
      expect(upload.fields.public_id).toMatch(/^vedora\/blog-videos\/.+/);
      expect(upload.fields.asset_folder).toBe('vedora/blog-videos');
      expect(url).toBe(
        `https://res.cloudinary.com/demo/video/upload/q_auto/${upload.fields.public_id}.mp4`,
      );
      expect(createService().isBlogVideoUrl(url)).toBe(true);
      expect(
        createService().isBlogVideoUrl(
          'https://res.cloudinary.com/other/video/upload/q_auto/vedora/blog-videos/a.mp4',
        ),
      ).toBe(false);
      expect(
        createService().isBlogVideoUrl(
          'https://res.cloudinary.com/demo/image/upload/vedora/blog-videos/a.png',
        ),
      ).toBe(false);
      expect(
        createService({ CLOUDINARY_CLOUD_NAME: '' }).isBlogVideoUrl(url),
      ).toBe(false);
    });

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

    it('throws 503 when signing without credentials', () => {
      expect(() =>
        createService({ CLOUDINARY_API_SECRET: '' }).signVideoUpload('id'),
      ).toThrow(FeatureUnavailableException);
    });
  });

  describe('verifyNotification', () => {
    const sign = (
      body: string,
      timestamp: string,
      algorithm: 'sha1' | 'sha256',
      secret = 'secret',
    ) =>
      createHash(algorithm)
        .update(body + timestamp + secret)
        .digest('hex');

    it.each(['sha1', 'sha256'] as const)(
      'accepts valid %s signatures within max age',
      (algorithm) => {
        const service = createService();
        const now = String(Math.floor(Date.now() / 1000));
        const body = '{"notification_type":"upload"}';
        expect(
          service.verifyNotification(body, now, sign(body, now, algorithm)),
        ).toBe(true);
      },
    );

    it('rejects non-finite timestamps', () => {
      const service = createService();
      expect(service.verifyNotification('{}', 'not-a-number', 'abc')).toBe(
        false,
      );
      expect(service.verifyNotification('{}', 'Infinity', 'abc')).toBe(false);
    });

    it('rejects expired or far-future timestamps', () => {
      const service = createService();
      const old = String(Math.floor(Date.now() / 1000) - 100);
      expect(
        service.verifyNotification('{}', old, sign('{}', old, 'sha256'), 60),
      ).toBe(false);

      const future = String(Math.floor(Date.now() / 1000) + 100);
      expect(
        service.verifyNotification(
          '{}',
          future,
          sign('{}', future, 'sha256'),
          60,
        ),
      ).toBe(false);
    });

    it('rejects wrong signatures and mismatched lengths', () => {
      const service = createService();
      const now = String(Math.floor(Date.now() / 1000));
      expect(
        service.verifyNotification(
          '{}',
          now,
          sign('{}', now, 'sha256', 'other'),
        ),
      ).toBe(false);
      expect(service.verifyNotification('{}', now, 'short')).toBe(false);
    });
  });

  describe('SDK operations', () => {
    it('finds and parses a video resource', async () => {
      const service = createService();
      const resourceSpy = vi
        .spyOn(cloudinary.api, 'resource')
        .mockResolvedValue({
          public_id: 'vedora/videos/m1',
          duration: 30,
          width: 1080,
          height: 1920,
          video: { dar: '9:16' },
          derived: [{ transformation: 'sp_auto/m3u8', format: 'm3u8' }],
        });

      const found = await service.findVideo('vedora/videos/m1');

      expect(resourceSpy).toHaveBeenCalledWith('vedora/videos/m1', {
        resource_type: 'video',
        media_metadata: true,
      });
      expect(found).toEqual({
        public_id: 'vedora/videos/m1',
        duration: 30,
        width: 1080,
        height: 1920,
        video: { dar: '9:16' },
        derived: [{ transformation: 'sp_auto/m3u8', format: 'm3u8' }],
      });
    });

    it('returns null when Cloudinary answers 404 for findVideo', async () => {
      const service = createService();
      vi.spyOn(cloudinary.api, 'resource').mockRejectedValue({
        error: { http_code: 404 },
      });

      await expect(
        service.findVideo('vedora/videos/missing'),
      ).resolves.toBeNull();
    });

    it('rethrows non-404 errors from findVideo', async () => {
      const service = createService();
      vi.spyOn(cloudinary.api, 'resource').mockRejectedValue({
        error: { http_code: 500 },
      });
      await expect(service.findVideo('vedora/videos/m1')).rejects.toEqual({
        error: { http_code: 500 },
      });

      vi.spyOn(cloudinary.api, 'resource').mockRejectedValue(null);
      await expect(service.findVideo('vedora/videos/m1')).rejects.toBeNull();
    });

    it('deletes video only when withCaptions is false, and captions too when true', async () => {
      const service = createService();
      const destroySpy = vi
        .spyOn(cloudinary.uploader, 'destroy')
        .mockResolvedValue({ result: 'ok' });
      const prefixSpy = vi
        .spyOn(cloudinary.api, 'delete_resources_by_prefix')
        .mockResolvedValue({ deleted: {} });

      await service.deleteMedia('m1', false);
      expect(destroySpy).toHaveBeenCalledWith('vedora/videos/m1', {
        resource_type: 'video',
        invalidate: true,
      });
      expect(prefixSpy).not.toHaveBeenCalled();

      await service.deleteMedia('m1', true);
      expect(prefixSpy).toHaveBeenCalledWith('vedora/captions/m1/', {
        resource_type: 'raw',
        invalidate: true,
      });
    });

    it('uploads a WebVTT caption track as base64 data URI and returns secure_url', async () => {
      const service = createService();
      const uploadSpy = vi
        .spyOn(cloudinary.uploader, 'upload')
        .mockResolvedValue({
          secure_url: 'https://res.cloudinary.com/demo/raw/upload/vi.vtt',
        } as never);

      const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nXin chào\n';
      const url = await service.uploadCaption('m1', 'vi', vtt);

      expect(url).toBe('https://res.cloudinary.com/demo/raw/upload/vi.vtt');
      expect(uploadSpy).toHaveBeenCalledWith(
        `data:text/vtt;base64,${Buffer.from(vtt, 'utf8').toString('base64')}`,
        {
          resource_type: 'raw',
          public_id: 'vedora/captions/m1/vi.vtt',
          asset_folder: 'vedora/captions',
          overwrite: true,
          invalidate: true,
        },
      );
    });
  });
});
