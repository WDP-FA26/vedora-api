import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  PostReportReason,
  PostReportStatus,
  PostStatus,
  PostType,
} from '../enums.js';
import { collectionSchema, onDelete } from './common.js';
import { Identified } from './user.schema.js';

/** Embedded blog article and ordered recipe links on a BLOG post. */
@Schema({ _id: false })
export class Blog {
  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, default: null })
  coverImageUrl!: string | null;

  @Prop({ type: String, default: '' })
  content!: string;

  @Prop({ type: String, default: '' })
  excerpt!: string;

  @Prop({ type: [String], required: true, default: [] })
  recipeIds!: string[];
}

export const BlogSchema = SchemaFactory.createForClass(Blog);

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

  @Prop({ type: BlogSchema, default: null })
  blog!: Blog | null;

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
PostSchema.index({ status: 1, publishedAt: 1 });
PostSchema.index({ authorId: 1, createdAt: 1 });
PostSchema.index({ 'blog.recipeIds': 1 });

onDelete(PostSchema, async (db, ids, session) => {
  const match = { postId: { $in: ids } };
  for (const modelName of [
    'Notification',
    'PostComment',
    'PostLike',
    'PostRepost',
    'PostBookmark',
    'PostReport',
  ] as const) {
    await db.model(modelName).deleteMany(match, { session }).exec();
  }
  for (const modelName of ['MediaAsset', 'Recipe'] as const) {
    await db
      .model(modelName)
      .updateMany(
        match,
        { $set: { postId: null } },
        { session, timestamps: false },
      )
      .exec();
  }
});

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
PostCommentSchema.index({ postId: 1, createdAt: 1, _id: 1 });
PostCommentSchema.index({ authorId: 1 });

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
PostLikeSchema.index({ postId: 1, userId: 1 }, { unique: true });
PostLikeSchema.index({ userId: 1 });

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
PostRepostSchema.index({ postId: 1, userId: 1 }, { unique: true });
PostRepostSchema.index({ userId: 1, createdAt: 1 });

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
PostBookmarkSchema.index({ postId: 1, userId: 1 }, { unique: true });
PostBookmarkSchema.index({ userId: 1, createdAt: 1 });

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
PostReportSchema.index({ postId: 1, reporterId: 1 }, { unique: true });
PostReportSchema.index({ status: 1, createdAt: 1 });
