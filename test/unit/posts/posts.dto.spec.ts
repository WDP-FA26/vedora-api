import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  PostReportReason,
  PostReportStatus,
  PostStatus,
  PostType,
} from '@src/mongo/models.js';
import {
  AdminPostsQueryDto,
  ModeratePostDto,
} from '@src/posts/dto/admin-post.dto.js';
import {
  BLOG_IMAGE_TYPES,
  CreateBlogImageUploadDto,
  MAX_BLOG_IMAGE_BYTES,
} from '@src/posts/dto/blog-image.dto.js';
import {
  CreateBlogDto,
  MAX_BLOG_CONTENT,
  MAX_BLOG_RECIPES,
  MyBlogsQueryDto,
  UpdateBlogDto,
} from '@src/posts/dto/blog.dto.js';
import {
  CommentBodyDto,
  MAX_COMMENT_BODY_LENGTH,
} from '@src/posts/dto/comment.dto.js';
import {
  countWords,
  CreatePostDto,
  MAX_POST_BODY_LENGTH,
  MAX_POST_BODY_WORDS,
  MAX_POST_MEDIA,
} from '@src/posts/dto/create-post.dto.js';
import {
  CreatePostReportDto,
  MAX_REPORT_DETAILS_LENGTH,
  MAX_VIEW_BATCH,
  PostReportsQueryDto,
  RecordViewsDto,
  ReviewPostReportDto,
} from '@src/posts/dto/post-interaction.dto.js';
import {
  MAX_SEARCH_QUERY_LENGTH,
  SearchPostsQueryDto,
} from '@src/posts/dto/search-posts-query.dto.js';

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';

describe('Posts DTOs', () => {
  describe('CreatePostDto & countWords', () => {
    it('counts whitespace-separated words accurately', () => {
      expect(countWords('')).toBe(0);
      expect(countWords('   \n\t  ')).toBe(0);
      expect(countWords('đậu hũ   sốt\ncà')).toBe(4);
    });

    it('trims body, validates word/length limits and mediaIds bounds', async () => {
      const valid = plainToInstance(CreatePostDto, {
        type: PostType.POST,
        body: '  Đậu hũ sốt cà  ',
        mediaIds: [UUID_1, UUID_2],
      });
      expect(valid.body).toBe('Đậu hũ sốt cà');
      await expect(validate(valid)).resolves.toHaveLength(0);

      // Non-string body fails IsString while Transform keeps non-string untouched
      const nonStringBody = plainToInstance(CreatePostDto, {
        type: PostType.POST,
        body: 123,
      });
      expect(nonStringBody.body).toBe(123);
      await expect(validate(nonStringBody)).resolves.not.toHaveLength(0);

      // Exceeding 250 words fails MaxWords
      const tooManyWords = plainToInstance(CreatePostDto, {
        type: PostType.POST,
        body: Array.from({ length: MAX_POST_BODY_WORDS + 1 }, () => 'a').join(
          ' ',
        ),
      });
      const wordErrors = await validate(tooManyWords);
      expect(wordErrors[0].constraints).toHaveProperty('maxWords');

      // Exceeding 2000 chars fails MaxLength
      const tooLong = plainToInstance(CreatePostDto, {
        type: PostType.POST,
        body: 'a'.repeat(MAX_POST_BODY_LENGTH + 1),
      });
      await expect(validate(tooLong)).resolves.not.toHaveLength(0);

      // Rejects BLOG type, duplicate mediaIds, >4 mediaIds, and non-UUID mediaIds
      const invalidType = plainToInstance(CreatePostDto, {
        type: PostType.BLOG,
      });
      await expect(validate(invalidType)).resolves.not.toHaveLength(0);

      const dupMedia = plainToInstance(CreatePostDto, {
        type: PostType.POST,
        mediaIds: [UUID_1, UUID_1],
      });
      await expect(validate(dupMedia)).resolves.not.toHaveLength(0);

      const tooManyMedia = plainToInstance(CreatePostDto, {
        type: PostType.POST,
        mediaIds: Array.from(
          { length: MAX_POST_MEDIA + 1 },
          (_, i) => `11111111-1111-4111-8111-11111111111${i}`,
        ),
      });
      await expect(validate(tooManyMedia)).resolves.not.toHaveLength(0);

      const badUuid = plainToInstance(CreatePostDto, {
        type: PostType.POST,
        mediaIds: ['not-a-uuid'],
      });
      await expect(validate(badUuid)).resolves.not.toHaveLength(0);
    });
  });

  describe('CommentBodyDto', () => {
    it('trims body, rejects whitespace-only or >1000 chars, and preserves non-string for IsString check', async () => {
      const valid = plainToInstance(CommentBodyDto, { body: '  Ngon quá!  ' });
      expect(valid.body).toBe('Ngon quá!');
      await expect(validate(valid)).resolves.toHaveLength(0);

      const blank = plainToInstance(CommentBodyDto, { body: '   ' });
      await expect(validate(blank)).resolves.not.toHaveLength(0);

      const tooLong = plainToInstance(CommentBodyDto, {
        body: 'x'.repeat(MAX_COMMENT_BODY_LENGTH + 1),
      });
      await expect(validate(tooLong)).resolves.not.toHaveLength(0);

      const nonString = plainToInstance(CommentBodyDto, { body: 42 });
      expect(nonString.body).toBe(42);
      await expect(validate(nonString)).resolves.not.toHaveLength(0);
    });
  });

  describe('SearchPostsQueryDto', () => {
    it('trims q, parses numeric cursor/limit, and validates bounds', async () => {
      const valid = plainToInstance(SearchPostsQueryDto, {
        q: '  bánh xèo  ',
        limit: '15',
        cursor: '20',
      });
      expect(valid.q).toBe('bánh xèo');
      expect(valid.limit).toBe(15);
      expect(valid.cursor).toBe(20);
      await expect(validate(valid)).resolves.toHaveLength(0);

      const emptyQ = plainToInstance(SearchPostsQueryDto, { q: '   ' });
      await expect(validate(emptyQ)).resolves.not.toHaveLength(0);

      const longQ = plainToInstance(SearchPostsQueryDto, {
        q: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1),
      });
      await expect(validate(longQ)).resolves.not.toHaveLength(0);

      const nonStringQ = plainToInstance(SearchPostsQueryDto, { q: 123 });
      await expect(validate(nonStringQ)).resolves.not.toHaveLength(0);

      const badCursor = plainToInstance(SearchPostsQueryDto, {
        q: 'phở',
        cursor: '-1',
      });
      await expect(validate(badCursor)).resolves.not.toHaveLength(0);

      const overCursor = plainToInstance(SearchPostsQueryDto, {
        q: 'phở',
        cursor: '201',
      });
      await expect(validate(overCursor)).resolves.not.toHaveLength(0);
    });
  });

  describe('Post interaction DTOs', () => {
    it('validates RecordViewsDto min/max batch and UUIDs', async () => {
      const valid = plainToInstance(RecordViewsDto, { postIds: [UUID_1] });
      await expect(validate(valid)).resolves.toHaveLength(0);

      const empty = plainToInstance(RecordViewsDto, { postIds: [] });
      await expect(validate(empty)).resolves.not.toHaveLength(0);

      const overBatch = plainToInstance(RecordViewsDto, {
        postIds: Array.from({ length: MAX_VIEW_BATCH + 1 }, () => UUID_1),
      });
      await expect(validate(overBatch)).resolves.not.toHaveLength(0);
    });

    it('validates CreatePostReportDto, PostReportsQueryDto, ReviewPostReportDto', async () => {
      const report = plainToInstance(CreatePostReportDto, {
        reason: PostReportReason.SPAM,
        details: '  spam link  ',
      });
      expect(report.details).toBe('spam link');
      await expect(validate(report)).resolves.toHaveLength(0);

      const nonStringDetails = plainToInstance(CreatePostReportDto, {
        reason: PostReportReason.SPAM,
        details: 99,
      });
      await expect(validate(nonStringDetails)).resolves.not.toHaveLength(0);

      const longDetails = plainToInstance(CreatePostReportDto, {
        reason: PostReportReason.HARASSMENT,
        details: 'a'.repeat(MAX_REPORT_DETAILS_LENGTH + 1),
      });
      await expect(validate(longDetails)).resolves.not.toHaveLength(0);

      const query = plainToInstance(PostReportsQueryDto, {
        page: '1',
        limit: '10',
        status: PostReportStatus.PENDING,
      });
      await expect(validate(query)).resolves.toHaveLength(0);

      const validReview = plainToInstance(ReviewPostReportDto, {
        status: PostReportStatus.RESOLVED,
      });
      await expect(validate(validReview)).resolves.toHaveLength(0);

      const invalidReview = plainToInstance(ReviewPostReportDto, {
        status: PostReportStatus.PENDING,
      });
      await expect(validate(invalidReview)).resolves.not.toHaveLength(0);
    });
  });

  describe('Admin post DTOs', () => {
    it('validates AdminPostsQueryDto and ModeratePostDto', async () => {
      const validQuery = plainToInstance(AdminPostsQueryDto, {
        page: '2',
        limit: '10',
        status: PostStatus.PENDING_REVIEW,
      });
      await expect(validate(validQuery)).resolves.toHaveLength(0);

      const badQuery = plainToInstance(AdminPostsQueryDto, {
        status: 'INVALID',
      });
      await expect(validate(badQuery)).resolves.not.toHaveLength(0);

      const validModerate = plainToInstance(ModeratePostDto, {
        decision: 'APPROVE',
        note: 'Looks good',
      });
      await expect(validate(validModerate)).resolves.toHaveLength(0);

      const badDecision = plainToInstance(ModeratePostDto, {
        decision: 'HOLD',
      });
      await expect(validate(badDecision)).resolves.not.toHaveLength(0);

      const longNote = plainToInstance(ModeratePostDto, {
        decision: 'REJECT',
        note: 'a'.repeat(501),
      });
      await expect(validate(longNote)).resolves.not.toHaveLength(0);
    });
  });

  describe('Blog & BlogImage DTOs', () => {
    it('validates CreateBlogImageUploadDto MIME types and byte bounds', async () => {
      for (const contentType of BLOG_IMAGE_TYPES) {
        const valid = plainToInstance(CreateBlogImageUploadDto, {
          contentType,
          sizeBytes: MAX_BLOG_IMAGE_BYTES,
        });
        await expect(validate(valid)).resolves.toHaveLength(0);
      }

      const invalidType = plainToInstance(CreateBlogImageUploadDto, {
        contentType: 'image/svg+xml',
        sizeBytes: 100,
      });
      await expect(validate(invalidType)).resolves.not.toHaveLength(0);

      const zeroSize = plainToInstance(CreateBlogImageUploadDto, {
        contentType: 'image/png',
        sizeBytes: 0,
      });
      await expect(validate(zeroSize)).resolves.not.toHaveLength(0);

      const overSize = plainToInstance(CreateBlogImageUploadDto, {
        contentType: 'image/png',
        sizeBytes: MAX_BLOG_IMAGE_BYTES + 1,
      });
      await expect(validate(overSize)).resolves.not.toHaveLength(0);
    });

    it('validates CreateBlogDto transforms, URLs, statuses, and recipeIds', async () => {
      const valid = plainToInstance(CreateBlogDto, {
        title: '  Đậu hũ sốt cà  ',
        content: '## Cách làm',
        coverImageUrl: '  https://example.com/cover.jpg  ',
        status: PostStatus.DRAFT,
        recipeIds: [UUID_1, UUID_2],
      });
      expect(valid.title).toBe('Đậu hũ sốt cà');
      expect(valid.coverImageUrl).toBe('https://example.com/cover.jpg');
      await expect(validate(valid)).resolves.toHaveLength(0);

      const nullCover = plainToInstance(CreateBlogDto, {
        title: 'Blog không ảnh',
        coverImageUrl: null,
      });
      await expect(validate(nullCover)).resolves.toHaveLength(0);

      const blankTitle = plainToInstance(CreateBlogDto, { title: '   ' });
      await expect(validate(blankTitle)).resolves.not.toHaveLength(0);

      const nonStringTitle = plainToInstance(CreateBlogDto, { title: 123 });
      await expect(validate(nonStringTitle)).resolves.not.toHaveLength(0);

      const overContent = plainToInstance(CreateBlogDto, {
        title: 'Title',
        content: 'a'.repeat(MAX_BLOG_CONTENT + 1),
      });
      await expect(validate(overContent)).resolves.not.toHaveLength(0);

      const badUrl = plainToInstance(CreateBlogDto, {
        title: 'Title',
        coverImageUrl: 'ftp://example.com/a.jpg',
      });
      await expect(validate(badUrl)).resolves.not.toHaveLength(0);

      const badStatus = plainToInstance(CreateBlogDto, {
        title: 'Title',
        status: PostStatus.PROCESSING,
      });
      await expect(validate(badStatus)).resolves.not.toHaveLength(0);

      const tooManyRecipes = plainToInstance(CreateBlogDto, {
        title: 'Title',
        recipeIds: Array.from(
          { length: MAX_BLOG_RECIPES + 1 },
          (_, i) =>
            `11111111-1111-4111-8111-1111111111${String(i).padStart(2, '0')}`,
        ),
      });
      await expect(validate(tooManyRecipes)).resolves.not.toHaveLength(0);
    });

    it('validates UpdateBlogDto null rules and MyBlogsQueryDto status', async () => {
      const validPatch = plainToInstance(UpdateBlogDto, {
        coverImageUrl: null,
      });
      await expect(validate(validPatch)).resolves.toHaveLength(0);

      const nullContent = plainToInstance(UpdateBlogDto, { content: null });
      await expect(validate(nullContent)).resolves.not.toHaveLength(0);

      const validQuery = plainToInstance(MyBlogsQueryDto, {
        status: PostStatus.PUBLISHED,
        limit: '10',
      });
      await expect(validate(validQuery)).resolves.toHaveLength(0);

      const badQuery = plainToInstance(MyBlogsQueryDto, {
        status: PostStatus.REJECTED,
      });
      await expect(validate(badQuery)).resolves.not.toHaveLength(0);
    });
  });
});
