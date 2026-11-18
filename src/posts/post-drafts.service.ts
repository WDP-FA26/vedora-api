import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { assertAccountActive } from '../auth-core/account-access.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { QuotaReachedException } from '../common/exceptions/quota-reached.exception.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { MediaService } from '../media/media.service.js';
import {
  MediaAsset,
  MediaStatus,
  MediaType,
  Post,
  PostStatus,
  PostType,
  User,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { lockDocument } from '../mongo/document-lock.js';
import { withUserLocks } from '../mongo/with-user-locks.js';
import {
  countWords,
  MAX_POST_BODY_LENGTH,
  MAX_POST_BODY_WORDS,
  MAX_POST_MEDIA,
} from './dto/create-post.dto.js';
import {
  CreatePostDraftDto,
  DraftUploadResponseDto,
  PostDraftDto,
  PostDraftPageDto,
  SavePostDraftDto,
} from './dto/post-draft.dto.js';
import { PostsQueryService } from './posts-query.service.js';
import { PostSearchIndexService } from './search/post-search-index.service.js';

@Injectable()
export class PostDraftsService {
  constructor(
    private readonly mongo: MongoService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name) private readonly media: Model<MediaAsset>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mediaService: MediaService,
    private readonly cloudinary: CloudinaryService,
    private readonly query: PostsQueryService,
    private readonly search: PostSearchIndexService,
  ) {}

  private async write<T>(
    ownerId: string,
    id: string,
    run: (session: ClientSession) => Promise<T>,
  ) {
    return withUserLocks(this.mongo, [ownerId], async (session) => {
      const user = await this.users.findById(ownerId).session(session).exec();
      if (!user)
        throw new ResourceNotFoundException('NOT_FOUND', 'Account not found');
      assertAccountActive(user.status);
      await lockDocument(this.mongo, session, 'post', id);
      return run(session);
    });
  }

  private async requireDraft(
    ownerId: string,
    id: string,
    session?: ClientSession,
  ): Promise<Post> {
    const post = await this.posts
      .findOne({
        _id: id,
        authorId: ownerId,
        type: PostType.POST,
        status: PostStatus.DRAFT,
        draftKind: { $ne: null },
      })
      .session(session ?? null)
      .exec();
    if (!post)
      throw new ResourceNotFoundException('NOT_FOUND', 'Draft not found');
    return post;
  }

  private async dto(
    post: Post,
    session?: ClientSession,
  ): Promise<PostDraftDto> {
    const media = await this.media
      .find({ postId: post.id, ownerId: post.authorId, discardedAt: null })
      .sort({ position: 1, _id: 1 })
      .session(session ?? null)
      .exec();
    return {
      id: post.id,
      kind: post.draftKind ?? 'POST',
      body: post.body ?? '',
      title: post.draftTitle,
      description: post.draftDescription,
      version: post.draftVersion,
      updatedAt: post.updatedAt,
      media: media.map((item) => this.mediaService.toResponse(item)),
    };
  }

  async create(
    ownerId: string,
    input: CreatePostDraftDto,
  ): Promise<PostDraftDto> {
    return this.write(ownerId, input.id, async (session) => {
      const existing = await this.posts
        .findById(input.id)
        .session(session)
        .exec();
      if (existing) {
        const post = await this.requireDraft(ownerId, input.id, session);
        if (post.draftKind !== input.kind)
          throw new StateConflictException('CONFLICT', 'Draft kind differs');
        return this.dto(post, session);
      }
      const count = await this.posts
        .countDocuments({
          authorId: ownerId,
          type: PostType.POST,
          status: PostStatus.DRAFT,
        })
        .session(session)
        .exec();
      if (count >= runtimeConfig.POST_MAX_DRAFTS_PER_USER)
        throw new QuotaReachedException(
          'UPLOAD_LIMIT_REACHED',
          'Too many post drafts',
        );
      const [post] = await this.posts.create(
        [
          {
            _id: input.id,
            authorId: ownerId,
            type: PostType.POST,
            status: PostStatus.DRAFT,
            draftKind: input.kind,
          },
        ],
        { session },
      );
      return this.dto(post, session);
    });
  }

  async list(ownerId: string): Promise<PostDraftPageDto> {
    const posts = await this.posts
      .find({
        authorId: ownerId,
        type: PostType.POST,
        status: PostStatus.DRAFT,
        draftKind: { $ne: null },
      })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(runtimeConfig.POST_MAX_DRAFTS_PER_USER)
      .exec();
    return { items: await Promise.all(posts.map((post) => this.dto(post))) };
  }

  async get(ownerId: string, id: string): Promise<PostDraftDto> {
    const post = await this.requireDraft(ownerId, id);
    if (!this.cloudinary.webhooksEnabled) {
      const pending = await this.media.find({
        postId: id,
        ownerId,
        discardedAt: null,
        status: { $in: [MediaStatus.WAITING_UPLOAD, MediaStatus.PROCESSING] },
      });
      await Promise.all(pending.map((item) => this.mediaService.refresh(item)));
    }
    return this.dto(post);
  }

  async save(
    ownerId: string,
    id: string,
    input: SavePostDraftDto,
  ): Promise<PostDraftDto> {
    return this.write(ownerId, id, async (session) => {
      const post = await this.requireDraft(ownerId, id, session);
      const title = input.title ?? post.draftTitle;
      const description = input.description ?? post.draftDescription;
      const body =
        post.draftKind === 'VIDEO' && input.body === undefined
          ? [title.trim(), description.trim()].filter(Boolean).join('\n\n')
          : (input.body ?? post.body ?? '');
      if (
        body.length > MAX_POST_BODY_LENGTH ||
        countWords(body) > MAX_POST_BODY_WORDS
      )
        throw new InvalidInputException(
          'BAD_REQUEST',
          'Draft text exceeds post limits',
        );
      if (
        body === (post.body ?? '') &&
        title === post.draftTitle &&
        description === post.draftDescription
      )
        return this.dto(post, session);
      this.version(post, input.expectedVersion);
      post.body = body || null;
      post.draftTitle = title;
      post.draftDescription = description;
      post.draftVersion++;
      await this.posts
        .updateOne(
          { _id: id },
          {
            $set: {
              body: post.body,
              draftTitle: title,
              draftDescription: description,
              draftVersion: post.draftVersion,
            },
          },
          { session },
        )
        .exec();
      return this.dto(await this.requireDraft(ownerId, id, session), session);
    });
  }

  private version(post: Post, expected: number) {
    if (post.draftVersion !== expected)
      throw new StateConflictException(
        'CONFLICT',
        'Draft changed in another session; reload before editing',
      );
  }

  async upload(
    ownerId: string,
    id: string,
    mediaId: string,
  ): Promise<DraftUploadResponseDto> {
    this.cloudinary.require();
    // A previous tab may have finished sending bytes before it closed. Reconcile before reissuing fields.
    await this.requireDraft(ownerId, id);
    const old = await this.media
      .findOne({ _id: mediaId, ownerId, postId: id, discardedAt: null })
      .exec();
    if (old) await this.mediaService.refresh(old);
    return this.write(ownerId, id, async (session) => {
      const post = await this.requireDraft(ownerId, id, session);
      let media = await this.media.findById(mediaId).session(session).exec();
      if (
        media &&
        (media.ownerId !== ownerId || media.postId !== id || media.discardedAt)
      )
        throw new InvalidInputException(
          'MEDIA_UNAVAILABLE',
          'Media is not part of this draft',
        );
      if (media?.status === MediaStatus.FAILED)
        throw new InvalidInputException(
          'MEDIA_UNAVAILABLE',
          'Remove the failed video before retrying with a new file ID',
        );
      if (!media) {
        const count = await this.media
          .countDocuments({ postId: id, discardedAt: null })
          .session(session)
          .exec();
        const max = post.draftKind === 'VIDEO' ? 1 : MAX_POST_MEDIA;
        if (count >= max)
          throw new InvalidInputException(
            'BAD_REQUEST',
            'Draft attachment limit reached',
          );
        [media] = await this.media.create(
          [
            {
              _id: mediaId,
              ownerId,
              postId: id,
              position: count,
              type: MediaType.VIDEO,
              publicId: this.cloudinary.videoPublicId(mediaId),
            },
          ],
          { session },
        );
        post.draftVersion++;
        await this.posts.updateOne(
          { _id: id },
          { $set: { draftVersion: post.draftVersion } },
          { session },
        );
      }
      return {
        draft: await this.dto(post, session),
        media: this.mediaService.toResponse(media),
        upload:
          media.status === MediaStatus.WAITING_UPLOAD
            ? this.cloudinary.signVideoUpload(media.publicId)
            : null,
      };
    });
  }

  async removeMedia(
    ownerId: string,
    id: string,
    mediaId: string,
    expected: number,
  ): Promise<PostDraftDto> {
    return this.write(ownerId, id, async (session) => {
      const post = await this.requireDraft(ownerId, id, session);
      const media = await this.media
        .findOne({ _id: mediaId, postId: id, ownerId, discardedAt: null })
        .session(session)
        .exec();
      if (!media) return this.dto(post, session);
      this.version(post, expected);
      await this.media.updateOne(
        { _id: mediaId },
        { $set: { discardedAt: new Date(), postId: null } },
        { session },
      );
      post.draftVersion++;
      await this.posts.updateOne(
        { _id: id },
        { $set: { draftVersion: post.draftVersion } },
        { session },
      );
      return this.dto(post, session);
    });
  }

  async publish(ownerId: string, id: string, expected: number) {
    const changed = await this.write(ownerId, id, async (session) => {
      const post = await this.posts
        .findOne({
          _id: id,
          authorId: ownerId,
          type: PostType.POST,
          draftKind: { $ne: null },
        })
        .session(session)
        .exec();
      if (!post)
        throw new ResourceNotFoundException('NOT_FOUND', 'Draft not found');
      if (post.status !== PostStatus.DRAFT) return false; // Retry an already committed publish, never create a second post.
      this.version(post, expected);
      const media = await this.media
        .find({ postId: id, ownerId, discardedAt: null })
        .session(session)
        .exec();
      if (!post.body?.trim() && !media.length)
        throw new InvalidInputException(
          'EMPTY_POST',
          'Write text or upload a video',
        );
      if (
        post.draftKind === 'VIDEO' &&
        (!post.draftTitle.trim() ||
          !post.draftDescription.trim() ||
          media.length !== 1)
      )
        throw new InvalidInputException(
          'BAD_REQUEST',
          'A video guide needs a title, description and one video',
        );
      if (
        media.some(
          (item) =>
            item.status === MediaStatus.WAITING_UPLOAD ||
            item.status === MediaStatus.FAILED,
        )
      )
        throw new InvalidInputException(
          'MEDIA_UNAVAILABLE',
          'Videos have not finished uploading or failed',
        );
      await this.posts.updateOne(
        { _id: id, status: PostStatus.DRAFT },
        {
          $set: { status: PostStatus.PROCESSING, moderation: null },
          $inc: { draftVersion: 1 },
        },
        { session },
      );
      return true;
    });
    if (changed) {
      await this.mediaService.settlePosts([id]);
      this.search.schedule();
    }
    return this.query.load(id, ownerId);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    await this.write(ownerId, id, async (session) => {
      await this.requireDraft(ownerId, id, session);
      await this.media.updateMany(
        { postId: id, ownerId },
        { $set: { discardedAt: new Date() } },
        { session },
      );
      await this.posts.deleteOne({ _id: id }, { session });
    });
  }
}
