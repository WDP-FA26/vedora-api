import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  MediaAsset,
  MediaFailureReason,
  MediaStatus,
  MediaType,
  PostStatus,
} from '@prisma/client';
import type { MockInstance } from 'vitest';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { CaptionService } from './caption.service';
import { MediaService } from './media.service';
import {
  mediaId,
  ownerId,
  pendingMedia,
  publicId,
  streamBuilt,
  uploaded,
  waitingMedia,
} from './media.fixtures';

describe('MediaService', () => {
  let service: MediaService;
  let prisma: DeepMockProxy<PrismaService>;
  let captions: DeepMockProxy<CaptionService>;
  let findVideo: MockInstance<CloudinaryService['findVideo']>;
  let deleteMedia: MockInstance<CloudinaryService['deleteMedia']>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    captions = mockDeep<CaptionService>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MediaService,
        CloudinaryService,
        { provide: PrismaService, useValue: prisma },
        { provide: CaptionService, useValue: captions },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CLOUDINARY_CLOUD_NAME: 'demo',
            CLOUDINARY_API_KEY: 'key',
            CLOUDINARY_API_SECRET: 'secret',
            MAX_VIDEO_DURATION_SEC: 180,
          }),
        },
      ],
    }).compile();
    service = moduleRef.get(MediaService);
    // The real CloudinaryService signs and builds URLs; only its API calls are mocked.
    const cloudinary = moduleRef.get(CloudinaryService);
    findVideo = vi.spyOn(cloudinary, 'findVideo').mockResolvedValue(null);
    deleteMedia = vi.spyOn(cloudinary, 'deleteMedia').mockResolvedValue();

    prisma.mediaAsset.findUnique.mockResolvedValue(waitingMedia);
    prisma.mediaAsset.findFirst.mockResolvedValue(pendingMedia);
    prisma.mediaAsset.findUniqueOrThrow.mockResolvedValue(pendingMedia);
    prisma.mediaAsset.updateMany.mockResolvedValue({ count: 1 });
    prisma.post.updateMany.mockResolvedValue({ count: 1 });
  });

  it('signs an upload that pins the public ID and the HLS job', async () => {
    prisma.mediaAsset.count.mockResolvedValue(0);
    prisma.mediaAsset.create.mockImplementation(
      ({ data }) =>
        ({ ...waitingMedia, ...data }) as unknown as ReturnType<
          typeof prisma.mediaAsset.create
        >,
    );

    const { media, upload } = await service.createUpload(
      ownerId,
      MediaType.VIDEO,
    );

    expect(media.publicId).toBe(`vedora/videos/${media.id}`);
    expect(upload.url).toBe(
      'https://api.cloudinary.com/v1_1/demo/video/upload',
    );
    expect(upload.fields).toMatchObject({
      public_id: media.publicId,
      eager: 'sp_auto/m3u8',
      eager_async: 'true',
      api_key: 'key',
    });
    expect(upload.fields.signature).toMatch(/^[0-9a-f]{40}$/);
  });

  it('records the upload and waits for the stream', async () => {
    await service.handleNotification(uploaded(42));

    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { id: mediaId, status: MediaStatus.WAITING_UPLOAD },
      data: {
        status: MediaStatus.PROCESSING,
        durationSec: 42,
        aspectRatio: '9:16',
      },
    });
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('marks media READY and publishes its post once the stream is built', async () => {
    await service.handleNotification(streamBuilt());

    const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
    expect(update.data).toEqual({ status: MediaStatus.READY });
    const [publish] = prisma.post.updateMany.mock.calls[1];
    expect(publish.data).toMatchObject({ status: PostStatus.PUBLISHED });
    expect(captions.schedule).toHaveBeenCalled();
  });

  it('reads the upload details when the stream finishes first', async () => {
    prisma.mediaAsset.findFirst.mockResolvedValue(waitingMedia);
    findVideo.mockResolvedValue({ public_id: publicId, duration: 42 });

    await service.handleNotification(streamBuilt());

    expect(findVideo).toHaveBeenCalledWith(publicId);
    const statuses = prisma.mediaAsset.updateMany.mock.calls.map(
      ([call]) => call.data.status,
    );
    expect(statuses).toEqual([MediaStatus.PROCESSING, MediaStatus.READY]);
  });

  it('ignores a replayed stream notification for media that is already READY', async () => {
    prisma.mediaAsset.findFirst.mockResolvedValue({
      ...pendingMedia,
      status: MediaStatus.READY,
    });

    await service.handleNotification(streamBuilt());

    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('ignores files outside the videos folder', async () => {
    await service.handleNotification({
      ...uploaded(42),
      public_id: 'someone-else/clip',
    });

    expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
  });

  it('fails videos over the duration limit and deletes them', async () => {
    prisma.mediaAsset.findFirst.mockResolvedValue(waitingMedia);

    await service.handleNotification(uploaded(181));

    const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
    expect(update.data).toEqual({
      status: MediaStatus.FAILED,
      failureReason: MediaFailureReason.TOO_LONG,
    });
    const [fail] = prisma.post.updateMany.mock.calls[0];
    expect(fail.data).toEqual({ status: PostStatus.FAILED });
    expect(deleteMedia).toHaveBeenCalledWith(mediaId, false);
  });

  it('fails a video whose stream could not be built', async () => {
    await service.handleNotification({
      ...streamBuilt(),
      eager: [{ status: 'failed' }],
    });

    const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
    expect(update.data).toEqual({
      status: MediaStatus.FAILED,
      failureReason: MediaFailureReason.ENCODING_FAILED,
    });
  });

  it('deletes a file whose row is already gone', async () => {
    prisma.mediaAsset.findUnique.mockResolvedValue(null);

    await service.handleNotification(uploaded(42));

    expect(deleteMedia).toHaveBeenCalledWith(mediaId, false);
    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
  });

  describe('polling without notifications', () => {
    it('publishes once the Admin API lists the HLS stream', async () => {
      findVideo.mockResolvedValue({
        public_id: publicId,
        duration: 42,
        derived: [{ transformation: 'sp_auto/pg_1/m3u8', format: 'm3u8' }],
      });
      prisma.mediaAsset.findUnique.mockResolvedValue(pendingMedia);

      await service.refresh(pendingMedia);

      const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
      expect(update.data).toEqual({ status: MediaStatus.READY });
    });

    it('asks the Admin API at most every 15 seconds per video', async () => {
      const fresh = { ...waitingMedia, createdAt: new Date() };
      await service.refresh(fresh);
      await service.refresh(fresh);

      expect(findVideo).toHaveBeenCalledTimes(1);
    });

    it('times out an upload whose file never arrived', async () => {
      prisma.mediaAsset.findFirst.mockResolvedValue(waitingMedia);

      await service.refresh(waitingMedia);

      const [update] = prisma.mediaAsset.updateMany.mock.calls[0];
      expect(update.data).toEqual({
        status: MediaStatus.FAILED,
        failureReason: MediaFailureReason.UPLOAD_TIMED_OUT,
      });
    });
  });

  describe('discarding', () => {
    const discarded: MediaAsset = {
      ...pendingMedia,
      discardedAt: new Date('2026-09-25T00:00:00.000Z'),
    };

    it('hides the upload, deletes it from Cloudinary, then drops the row', async () => {
      prisma.mediaAsset.findMany.mockResolvedValue([pendingMedia]);

      await service.removeOwned(mediaId, ownerId);

      const [mark] = prisma.mediaAsset.updateMany.mock.calls[0];
      expect(mark.data.discardedAt).toBeInstanceOf(Date);
      expect(deleteMedia).toHaveBeenCalledWith(mediaId, false);
      expect(prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({
        where: { id: mediaId, discardedAt: { not: null } },
      });
    });

    it('also deletes the captions of a transcribed video', async () => {
      await service.purge({ ...discarded, captionStatus: 'READY' });

      expect(deleteMedia).toHaveBeenCalledWith(mediaId, true);
    });

    it('keeps the row while its upload could still finish', async () => {
      const gone = await service.purge({
        ...discarded,
        status: MediaStatus.WAITING_UPLOAD,
        createdAt: new Date(),
      });

      expect(gone).toBe(false);
      expect(deleteMedia).toHaveBeenCalled();
      expect(prisma.mediaAsset.deleteMany).not.toHaveBeenCalled();
    });

    it('keeps the row for a retry when deletion fails', async () => {
      deleteMedia.mockRejectedValue(new Error('Cloudinary down'));

      await service.purge(discarded);

      expect(prisma.mediaAsset.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes a file that finished uploading after the discard', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(discarded);

      await service.handleNotification(uploaded(42));

      expect(deleteMedia).toHaveBeenCalledWith(mediaId, false);
      expect(prisma.mediaAsset.deleteMany).toHaveBeenCalled();
      expect(prisma.post.updateMany).not.toHaveBeenCalled();
    });
  });
});
