import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import { QuotaReachedException } from '../../../src/common/exceptions/quota-reached.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { CreateUploadDto } from '../../../src/media/dto/create-upload.dto.js';
import {
  AdminMediaDto,
  CaptionTrackDto,
  CreateUploadResponseDto,
  MediaResponseDto,
  SignedUploadDto,
} from '../../../src/media/dto/media-response.dto.js';
import { MediaController } from '../../../src/media/media.controller.js';
import { MediaService } from '../../../src/media/media.service.js';
import {
  CaptionStatus,
  MediaStatus,
  MediaType,
  UserRole,
} from '../../../src/mongo/models.js';

const userRequest = {
  user: { sub: 'user-1', username: 'cook', role: UserRole.USER },
} as AuthenticatedRequest;

const sampleMedia: MediaResponseDto = {
  id: '0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11',
  type: MediaType.VIDEO,
  status: MediaStatus.WAITING_UPLOAD,
  failureReason: null,
  publicId: 'vedora/videos/0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11',
  playbackUrl: null,
  posterUrl: null,
  durationSec: null,
  aspectRatio: null,
  captions: [],
};

describe('MediaController', () => {
  it('delegates upload creation to MediaService for the authenticated user', async () => {
    const mediaService = mockDeep<MediaService>();
    const created: CreateUploadResponseDto = {
      media: sampleMedia,
      upload: {
        url: 'https://api.cloudinary.com/v1_1/demo/video/upload',
        fields: { public_id: sampleMedia.publicId },
        chunkSize: 20 * 1024 * 1024,
      },
    };
    mediaService.createUpload.mockResolvedValue(created);

    const controller = new MediaController(mediaService);
    const result = await controller.createUpload(userRequest, {
      type: MediaType.VIDEO,
    });

    expect(mediaService.createUpload).toHaveBeenCalledWith(
      'user-1',
      MediaType.VIDEO,
    );
    expect(result).toEqual(created);
  });

  it('propagates quota errors when starting an upload', async () => {
    const mediaService = mockDeep<MediaService>();
    mediaService.createUpload.mockRejectedValue(
      new QuotaReachedException('UPLOAD_LIMIT_REACHED', 'Too many uploads'),
    );
    const controller = new MediaController(mediaService);

    await expect(
      controller.createUpload(userRequest, { type: MediaType.VIDEO }),
    ).rejects.toMatchObject({ statusCode: 429, code: 'UPLOAD_LIMIT_REACHED' });
  });

  it('fetches owned media by id and user sub', async () => {
    const mediaService = mockDeep<MediaService>();
    mediaService.findOwned.mockResolvedValue(sampleMedia);
    const controller = new MediaController(mediaService);

    const result = await controller.findOne(userRequest, sampleMedia.id);

    expect(mediaService.findOwned).toHaveBeenCalledWith(
      sampleMedia.id,
      'user-1',
    );
    expect(result).toEqual(sampleMedia);
  });

  it('propagates not-found errors from findOne', async () => {
    const mediaService = mockDeep<MediaService>();
    mediaService.findOwned.mockRejectedValue(
      new ResourceNotFoundException('NOT_FOUND', 'Media not found'),
    );
    const controller = new MediaController(mediaService);

    await expect(
      controller.findOne(userRequest, sampleMedia.id),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('removes owned media and resolves void', async () => {
    const mediaService = mockDeep<MediaService>();
    mediaService.removeOwned.mockResolvedValue(undefined);
    const controller = new MediaController(mediaService);

    await expect(
      controller.remove(userRequest, sampleMedia.id),
    ).resolves.toBeUndefined();
    expect(mediaService.removeOwned).toHaveBeenCalledWith(
      sampleMedia.id,
      'user-1',
    );
  });

  it('propagates conflict when discarding media attached to a post', async () => {
    const mediaService = mockDeep<MediaService>();
    mediaService.removeOwned.mockRejectedValue(
      new StateConflictException('CONFLICT', 'Media is attached to a post'),
    );
    const controller = new MediaController(mediaService);

    await expect(
      controller.remove(userRequest, sampleMedia.id),
    ).rejects.toBeInstanceOf(StateConflictException);
  });
});

describe('Media DTOs', () => {
  it('accepts VIDEO and rejects unsupported upload types', async () => {
    const valid = plainToInstance(CreateUploadDto, { type: MediaType.VIDEO });
    await expect(validate(valid)).resolves.toHaveLength(0);

    const invalid = plainToInstance(CreateUploadDto, { type: 'IMAGE' });
    expect((await validate(invalid)).some((e) => e.property === 'type')).toBe(
      true,
    );
  });

  it('instantiates response DTO classes cleanly', () => {
    const track = plainToInstance(CaptionTrackDto, {
      languageCode: 'vi',
      name: 'Tiếng Việt',
      isOriginal: true,
      url: 'https://cdn/vi.vtt',
    });
    const adminMedia = plainToInstance(AdminMediaDto, {
      ...sampleMedia,
      captionStatus: CaptionStatus.READY,
      captionLanguage: 'vi',
      captions: [track],
    });
    const signed = plainToInstance(SignedUploadDto, {
      url: 'https://api.cloudinary.com/v1_1/demo/video/upload',
      fields: {},
      chunkSize: 1024,
    });
    const response = plainToInstance(CreateUploadResponseDto, {
      media: sampleMedia,
      upload: signed,
    });

    expect(adminMedia).toBeInstanceOf(AdminMediaDto);
    expect(response).toBeInstanceOf(CreateUploadResponseDto);
  });
});
