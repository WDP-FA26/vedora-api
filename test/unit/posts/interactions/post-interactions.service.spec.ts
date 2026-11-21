import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { AccessDeniedException } from '../../../../src/common/exceptions/access-denied.exception.js';
import { InvalidInputException } from '../../../../src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../../../src/common/exceptions/resource-not-found.exception.js';
import { ContentModerationService } from '../../../../src/moderation/content-moderation.service.js';
import {
  NotificationType,
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostRepost,
  PostStatus,
  type User,
  UserRole,
} from '../../../../src/mongo/models.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../../src/mongo/mongo.service.js';
import { NotificationsService } from '../../../../src/notifications/notifications.service.js';
import { PostInteractionsService } from '../../../../src/posts/interactions/post-interactions.service.js';
import { createPost, createUser } from '../../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';

describe('PostInteractionsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: PostInteractionsService;
  let commentsModel: Model<PostComment>;
  let likesModel: Model<PostLike>;
  let repostsModel: Model<PostRepost>;
  let bookmarksModel: Model<PostBookmark>;
  let notifications: DeepMockProxy<NotificationsService>;
  let contentModeration: DeepMockProxy<ContentModerationService>;
  let author: User;
  let commenter: User;
  let admin: User;
  let post: Post;

  beforeAll(async () => {
    notifications = mockDeep<NotificationsService>();
    contentModeration = mockDeep<ContentModerationService>();

    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('postinteractions'))],
      providers: [
        PostInteractionsService,
        { provide: NotificationsService, useValue: notifications },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(PostInteractionsService);
    commentsModel = app.get(getModelToken(PostComment.name));
    likesModel = app.get(getModelToken(PostLike.name));
    repostsModel = app.get(getModelToken(PostRepost.name));
    bookmarksModel = app.get(getModelToken(PostBookmark.name));
    author = await createUser(db, { username: 'post.author' });
    commenter = await createUser(db, { username: 'post.commenter' });
    admin = await createUser(db, {
      username: 'post.admin',
      role: UserRole.ADMIN,
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    notifications.notify.mockResolvedValue();
    contentModeration.requireAllowed.mockResolvedValue();
    post = await createPost(db, {
      authorId: author.id,
      status: PostStatus.PUBLISHED,
    });
  });

  afterEach(async () => {
    await Promise.all([
      db.connection.model(Post.name).deleteMany({}),
      commentsModel.deleteMany({}),
      likesModel.deleteMany({}),
      repostsModel.deleteMany({}),
      bookmarksModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('comments', () => {
    it('creates, moderates, notifies, lists with cursor pagination, updates, and deletes comments', async () => {
      const c1 = await service.createComment(post.id, commenter.id, {
        body: 'Bình luận 1',
      });
      expect(contentModeration.requireAllowed).toHaveBeenCalledWith([
        { kind: 'text', text: 'Bình luận 1' },
      ]);
      expect(notifications.notify).toHaveBeenCalledWith({
        recipientId: author.id,
        actorId: commenter.id,
        type: NotificationType.COMMENT,
        postId: post.id,
        commentId: c1.id,
      });

      const c2 = await service.createComment(post.id, author.id, {
        body: 'Bình luận 2',
      });
      await commentsModel
        .updateOne(
          { _id: c1.id },
          { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } },
        )
        .exec();
      await commentsModel
        .updateOne(
          { _id: c2.id },
          { $set: { createdAt: new Date('2026-01-02T00:00:00Z') } },
        )
        .exec();

      const page1 = await service.listComments(post.id, { limit: 1 });
      expect(page1.items.map((c) => c.id)).toEqual([c2.id]);
      expect(page1.nextCursor).toBe(c2.id);

      const page2 = await service.listComments(post.id, {
        limit: 1,
        cursor: c2.id,
      });
      expect(page2.items.map((c) => c.id)).toEqual([c1.id]);
      expect(page2.nextCursor).toBeNull();

      await expect(
        service.listComments(post.id, { limit: 10, cursor: 'missing-cursor' }),
      ).rejects.toBeInstanceOf(InvalidInputException);

      // Update comment: only comment author allowed
      const commenterActor = {
        sub: commenter.id,
        username: commenter.username,
        role: UserRole.USER,
      };
      const authorActor = {
        sub: author.id,
        username: author.username,
        role: UserRole.USER,
      };
      const adminActor = {
        sub: admin.id,
        username: admin.username,
        role: UserRole.ADMIN,
      };

      await expect(
        service.updateComment(post.id, c1.id, authorActor, { body: 'Nope' }),
      ).rejects.toBeInstanceOf(AccessDeniedException);

      const updated = await service.updateComment(
        post.id,
        c1.id,
        commenterActor,
        { body: 'Đã sửa' },
      );
      expect(updated.body).toBe('Đã sửa');

      // Delete comment: outsider forbidden; post author, comment author, and admin allowed
      const outsider = await createUser(db, { username: 'outsider' });
      await expect(
        service.removeComment(post.id, c1.id, {
          sub: outsider.id,
          username: outsider.username,
          role: UserRole.USER,
        }),
      ).rejects.toBeInstanceOf(AccessDeniedException);

      await service.removeComment(post.id, c1.id, authorActor);
      await expect(
        service.removeComment(post.id, c1.id, commenterActor),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await service.removeComment(post.id, c2.id, adminActor);
      expect(await commentsModel.countDocuments({ postId: post.id })).toBe(0);
    });

    it('rejects comment operations on unpublished posts or mismatched commentId', async () => {
      const draft = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PROCESSING,
        publishedAt: null,
      });
      await expect(
        service.listComments(draft.id, { limit: 10 }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      await expect(
        service.createComment(draft.id, commenter.id, { body: 'Hi' }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      const otherPost = await createPost(db, { authorId: author.id });
      const otherComment = await service.createComment(
        otherPost.id,
        commenter.id,
        { body: 'Other' },
      );
      await expect(
        service.updateComment(
          post.id,
          otherComment.id,
          {
            sub: commenter.id,
            username: commenter.username,
            role: UserRole.USER,
          },
          { body: 'Edit' },
        ),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('aborts createComment when moderation rejects', async () => {
      contentModeration.requireAllowed.mockRejectedValueOnce(
        new Error('CONTENT_REJECTED'),
      );
      await expect(
        service.createComment(post.id, commenter.id, { body: 'Bad' }),
      ).rejects.toThrow('CONTENT_REJECTED');
      expect(await commentsModel.countDocuments({ postId: post.id })).toBe(0);
    });
  });

  describe('reply threads', () => {
    const actor = (user: User) => ({
      sub: user.id,
      username: user.username,
      role: user.role,
      actorId: null,
    });

    it('flattens replies, addresses the selected author, counts roots, and preserves post timestamps', async () => {
      const root = await service.createComment(post.id, commenter.id, {
        body: 'Root',
      });
      notifications.notify.mockClear();
      const first = await service.createReply(post.id, root.id, admin.id, {
        body: 'First',
      });
      expect(first).toMatchObject({
        parentId: root.id,
        replyToId: root.id,
        replyCount: 0,
        replyToAuthor: { id: commenter.id },
      });
      expect(notifications.notify).toHaveBeenCalledWith({
        recipientId: commenter.id,
        actorId: admin.id,
        type: NotificationType.COMMENT_REPLY,
        postId: post.id,
        commentId: first.id,
      });
      expect(notifications.notify).toHaveBeenCalledWith({
        recipientId: author.id,
        actorId: admin.id,
        type: NotificationType.COMMENT,
        postId: post.id,
        commentId: first.id,
      });
      const second = await service.createReply(
        post.id,
        first.id,
        commenter.id,
        { body: 'Second' },
      );
      expect(second).toMatchObject({
        parentId: root.id,
        replyToId: first.id,
        replyToAuthor: { id: admin.id },
      });
      const roots = await service.listComments(post.id, { limit: 10 });
      expect(roots.items).toHaveLength(1);
      expect(roots.items[0]).toMatchObject({
        id: root.id,
        parentId: null,
        replyCount: 2,
      });
      const replies = await service.listReplies(post.id, root.id, { limit: 1 });
      expect(replies.items.map((row) => row.id)).toEqual([second.id]);
      expect(
        (
          await service.listReplies(post.id, root.id, {
            limit: 1,
            cursor: replies.nextCursor!,
          })
        ).items.map((row) => row.id),
      ).toEqual([first.id]);
      expect(await service.getComment(post.id, second.id)).toMatchObject({
        id: second.id,
        parentId: root.id,
      });
      const savedPost = await db.connection
        .model<Post>(Post.name)
        .findById(post.id)
        .orFail();
      expect(savedPost.updatedAt).toEqual(post.updatedAt);
    });

    it('skips self notifications and avoids duplicate notifications to the post author', async () => {
      const root = await service.createComment(post.id, author.id, {
        body: 'Root',
      });
      notifications.notify.mockClear();
      await service.createReply(post.id, root.id, commenter.id, {
        body: 'Reply',
      });
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientId: author.id,
          type: NotificationType.COMMENT_REPLY,
        }),
      );
      notifications.notify.mockClear();
      await service.createReply(post.id, root.id, author.id, { body: 'Self' });
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('rejects cross-post and cross-thread cursors before moderation and rejects moderation without writes', async () => {
      const root = await service.createComment(post.id, commenter.id, {
        body: 'Root',
      });
      const otherRoot = await service.createComment(post.id, commenter.id, {
        body: 'Other',
      });
      const reply = await service.createReply(post.id, root.id, admin.id, {
        body: 'Reply',
      });
      await expect(
        service.listReplies(post.id, reply.id, { limit: 10 }),
      ).rejects.toBeInstanceOf(InvalidInputException);
      await expect(
        service.listReplies(post.id, otherRoot.id, {
          limit: 10,
          cursor: reply.id,
        }),
      ).rejects.toBeInstanceOf(InvalidInputException);
      await expect(
        service.listComments(post.id, { limit: 10, cursor: reply.id }),
      ).rejects.toBeInstanceOf(InvalidInputException);
      const otherPost = await createPost(db, { authorId: author.id });
      contentModeration.requireAllowed.mockClear();
      await expect(
        service.createReply(otherPost.id, root.id, author.id, {
          body: 'Wrong scope',
        }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      expect(contentModeration.requireAllowed).not.toHaveBeenCalled();
      contentModeration.requireAllowed.mockRejectedValueOnce(
        new Error('CONTENT_REJECTED'),
      );
      await expect(
        service.createReply(post.id, root.id, author.id, { body: 'Bad' }),
      ).rejects.toThrow('CONTENT_REJECTED');
      expect(await commentsModel.countDocuments({ parentId: root.id })).toBe(1);
    });

    it('keeps sibling replies when a reply is deleted and cascades roots and notifications atomically', async () => {
      const root = await service.createComment(post.id, commenter.id, {
        body: 'Root',
      });
      const first = await service.createReply(post.id, root.id, admin.id, {
        body: 'First',
      });
      const second = await service.createReply(post.id, first.id, author.id, {
        body: 'Second',
      });
      await expect(
        service.updateComment(post.id, first.id, actor(commenter), {
          body: 'Unauthorized',
        }),
      ).rejects.toBeInstanceOf(AccessDeniedException);
      await expect(
        service.updateComment(post.id, first.id, actor(admin), {
          body: 'Edited',
        }),
      ).resolves.toMatchObject({ body: 'Edited', parentId: root.id });
      await service.removeComment(post.id, first.id, actor(admin));
      expect(await service.getComment(post.id, second.id)).toMatchObject({
        replyToId: null,
        replyToAuthor: null,
        parentId: root.id,
      });
      const notes = db.connection.model('Notification');
      await notes.create({
        recipientId: commenter.id,
        actorId: author.id,
        type: NotificationType.COMMENT_REPLY,
        postId: post.id,
        commentId: second.id,
      });
      await service.removeComment(post.id, root.id, actor(commenter));
      expect(await commentsModel.countDocuments({ postId: post.id })).toBe(0);
      expect(await notes.countDocuments({ commentId: second.id })).toBe(0);
    });

    it.each(['root', 'post', 'account'] as const)(
      'prevents orphan replies when the %s disappears during moderation',
      async (kind) => {
        const rootAuthor = await createUser(db);
        const root = await service.createComment(post.id, rootAuthor.id, {
          body: 'Root',
        });
        contentModeration.requireAllowed.mockImplementationOnce(async () => {
          if (kind === 'root')
            await service.removeComment(post.id, root.id, actor(rootAuthor));
          if (kind === 'post')
            await db.withTransaction((session) =>
              db.connection
                .model(Post.name)
                .deleteOne({ _id: post.id }, { session })
                .exec(),
            );
          if (kind === 'account')
            await db.withTransaction((session) =>
              db.connection
                .model('User')
                .deleteOne({ _id: rootAuthor.id }, { session })
                .exec(),
            );
        });
        await expect(
          service.createReply(post.id, root.id, admin.id, { body: 'Too late' }),
        ).rejects.toBeInstanceOf(ResourceNotFoundException);
        expect(await commentsModel.countDocuments({ parentId: root.id })).toBe(
          0,
        );
      },
    );

    it('serializes simultaneous replies against root deletion without orphaning children', async () => {
      const root = await service.createComment(post.id, commenter.id, {
        body: 'Root',
      });
      const results = await Promise.allSettled([
        ...Array.from({ length: 3 }, () =>
          service.createReply(post.id, root.id, admin.id, {
            body: 'Concurrent',
          }),
        ),
        service.removeComment(post.id, root.id, actor(commenter)),
      ]);
      expect(results.at(-1)?.status).toBe('fulfilled');
      for (const result of results
        .slice(0, -1)
        .filter((item) => item.status === 'rejected'))
        expect(result.reason).toBeInstanceOf(ResourceNotFoundException);
      expect(await commentsModel.countDocuments({ postId: post.id })).toBe(0);
    });
  });

  describe('likes, reposts, and bookmarks', () => {
    it('handles idempotent like/unlike and notifies only once', async () => {
      await expect(
        service.setLike(post.id, commenter.id, true),
      ).resolves.toEqual({
        postId: post.id,
        isLiked: true,
        likeCount: 1,
      });
      await expect(
        service.setLike(post.id, commenter.id, true),
      ).resolves.toEqual({
        postId: post.id,
        isLiked: true,
        likeCount: 1,
      });
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith({
        recipientId: author.id,
        actorId: commenter.id,
        type: NotificationType.LIKE,
        postId: post.id,
      });

      await expect(
        service.setLike(post.id, commenter.id, false),
      ).resolves.toEqual({
        postId: post.id,
        isLiked: false,
        likeCount: 0,
      });
      await expect(
        service.setLike(post.id, commenter.id, false),
      ).resolves.toEqual({
        postId: post.id,
        isLiked: false,
        likeCount: 0,
      });
    });

    it('handles idempotent repost/unrepost and notifies only once', async () => {
      await expect(
        service.setRepost(post.id, commenter.id, true),
      ).resolves.toEqual({
        postId: post.id,
        isReposted: true,
        repostCount: 1,
      });
      await expect(
        service.setRepost(post.id, commenter.id, true),
      ).resolves.toEqual({
        postId: post.id,
        isReposted: true,
        repostCount: 1,
      });
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith({
        recipientId: author.id,
        actorId: commenter.id,
        type: NotificationType.REPOST,
        postId: post.id,
      });

      await expect(
        service.setRepost(post.id, commenter.id, false),
      ).resolves.toEqual({
        postId: post.id,
        isReposted: false,
        repostCount: 0,
      });
    });

    it('handles idempotent bookmark and allows unbookmarking an unpublished post', async () => {
      await expect(
        service.setBookmark(post.id, commenter.id, true),
      ).resolves.toEqual({ postId: post.id, isBookmarked: true });
      await expect(
        service.setBookmark(post.id, commenter.id, true),
      ).resolves.toEqual({ postId: post.id, isBookmarked: true });

      const draft = await createPost(db, {
        authorId: author.id,
        status: PostStatus.DRAFT,
        publishedAt: null,
      });
      await expect(
        service.setBookmark(draft.id, commenter.id, true),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      await db.connection
        .model(Post.name)
        .updateOne({ _id: post.id }, { $set: { status: PostStatus.DRAFT } })
        .exec();
      await expect(
        service.setBookmark(post.id, commenter.id, false),
      ).resolves.toEqual({ postId: post.id, isBookmarked: false });
      expect(
        await bookmarksModel.countDocuments({
          postId: post.id,
          userId: commenter.id,
        }),
      ).toBe(0);
    });
  });
});
