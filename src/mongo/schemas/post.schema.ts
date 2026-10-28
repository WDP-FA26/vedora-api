import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  PostReportReason,
  PostReportStatus,
  PostStatus,
  PostType,
} from '../enums';
import { collectionSchema, indexName } from './common';
import { Identified } from './user.schema';

@Schema(collectionSchema('posts'))
export class Post extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  authorId!: string;

  @Prop({
    type: String,
    enum: Object.values(PostType),
    required: true,
    default: PostType.POST,
  })
  type!: PostType;

  @Prop({
    type: String,
    enum: Object.values(PostStatus),
    required: true,
    default: PostStatus.PROCESSING,
  })
  status!: PostStatus;

  @Prop({ type: String, default: null })
  body!: string | null;

  @Prop({ type: Date, default: null })
  searchIndexedAt!: Date | null;

  @Prop({ type: Number, required: true, default: 0 })
  viewCount!: number;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const PostSchema = SchemaFactory.createForClass(Post);
PostSchema.index(
  { status: 1, publishedAt: 1 },
  { name: indexName('posts', ['status', 'publishedAt'], 'idx') },
);
PostSchema.index(
  { authorId: 1, createdAt: 1 },
  { name: indexName('posts', ['authorId', 'createdAt'], 'idx') },
);

/** `_id` is the post id: one blog per post. */
@Schema(collectionSchema('blogs', 'updated'))
export class Blog extends Identified {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, default: null })
  coverImageUrl!: string | null;

  @Prop({ type: String, required: true })
  content!: string;

  @Prop({ type: String, required: true })
  excerpt!: string;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const BlogSchema = SchemaFactory.createForClass(Blog);

@Schema(collectionSchema('blog_recipes', 'none'))
export class BlogRecipe extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  recipeId!: string;

  @Prop({ type: Number, required: true })
  position!: number;
}

export const BlogRecipeSchema = SchemaFactory.createForClass(BlogRecipe);
BlogRecipeSchema.index(
  { postId: 1, recipeId: 1 },
  {
    unique: true,
    name: indexName('blog_recipes', ['postId', 'recipeId'], 'key'),
  },
);
BlogRecipeSchema.index(
  { recipeId: 1 },
  { name: indexName('blog_recipes', ['recipeId'], 'idx') },
);

@Schema(collectionSchema('post_comments'))
export class PostComment extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  authorId!: string;

  @Prop({ type: String, required: true })
  body!: string;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const PostCommentSchema = SchemaFactory.createForClass(PostComment);
PostCommentSchema.index(
  { postId: 1, createdAt: 1, _id: 1 },
  { name: 'post_comments_postId_createdAt__id_idx' },
);
PostCommentSchema.index(
  { authorId: 1 },
  { name: indexName('post_comments', ['authorId'], 'idx') },
);

@Schema(collectionSchema('post_likes', 'created'))
export class PostLike extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PostLikeSchema = SchemaFactory.createForClass(PostLike);
PostLikeSchema.index(
  { postId: 1, userId: 1 },
  { unique: true, name: indexName('post_likes', ['postId', 'userId'], 'key') },
);
PostLikeSchema.index(
  { userId: 1 },
  { name: indexName('post_likes', ['userId'], 'idx') },
);

@Schema(collectionSchema('post_reposts', 'created'))
export class PostRepost extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PostRepostSchema = SchemaFactory.createForClass(PostRepost);
PostRepostSchema.index(
  { postId: 1, userId: 1 },
  {
    unique: true,
    name: indexName('post_reposts', ['postId', 'userId'], 'key'),
  },
);
PostRepostSchema.index(
  { userId: 1, createdAt: 1 },
  { name: indexName('post_reposts', ['userId', 'createdAt'], 'idx') },
);

@Schema(collectionSchema('post_bookmarks', 'created'))
export class PostBookmark extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PostBookmarkSchema = SchemaFactory.createForClass(PostBookmark);
PostBookmarkSchema.index(
  { postId: 1, userId: 1 },
  {
    unique: true,
    name: indexName('post_bookmarks', ['postId', 'userId'], 'key'),
  },
);
PostBookmarkSchema.index(
  { userId: 1, createdAt: 1 },
  { name: indexName('post_bookmarks', ['userId', 'createdAt'], 'idx') },
);

@Schema(collectionSchema('post_reports', 'created'))
export class PostReport extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({ type: String, required: true })
  reporterId!: string;

  @Prop({ type: String, enum: Object.values(PostReportReason), required: true })
  reason!: PostReportReason;

  @Prop({ type: String, default: null })
  details!: string | null;

  @Prop({
    type: String,
    enum: Object.values(PostReportStatus),
    required: true,
    default: PostReportStatus.PENDING,
  })
  status!: PostReportStatus;

  @Prop({ type: String, default: null })
  reviewedById!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const PostReportSchema = SchemaFactory.createForClass(PostReport);
PostReportSchema.index(
  { postId: 1, reporterId: 1 },
  {
    unique: true,
    name: indexName('post_reports', ['postId', 'reporterId'], 'key'),
  },
);
PostReportSchema.index(
  { status: 1, createdAt: 1 },
  { name: indexName('post_reports', ['status', 'createdAt'], 'idx') },
);
