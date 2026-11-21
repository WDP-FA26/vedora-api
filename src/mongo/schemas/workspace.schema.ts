import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { VerificationStatus, WorkspaceMemberRole } from '../enums.js';
import { cascadeOnDelete, collectionSchema } from './common.js';
import { Identified } from './identified.js';

/** A GeoJSON point. Coordinates are `[longitude, latitude]`, in that order. */
@Schema({ _id: false, versionKey: false })
export class GeoPoint {
  @Prop({ type: String, enum: ['Point'], required: true, default: 'Point' })
  type!: 'Point';

  @Prop({ type: [Number], required: true })
  coordinates!: [number, number];
}

export const GeoPointSchema = SchemaFactory.createForClass(GeoPoint);

/**
 * A restaurant page application. The page's own account (`pageUserId`, a
 * User with accountType PAGE) is only created when an admin approves it, so
 * a pending or rejected page never shows up as a profile, in search or in
 * the admin user list. `username`, `name` and `bio` are what the page
 * account starts with; after approval the members edit them on the page's
 * profile like any account.
 */
@Schema(collectionSchema('workspaces'))
export class Workspace extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, default: null })
  pageUserId!: string | null;

  @Prop({ type: String, required: true })
  username!: string;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: String, default: null })
  bio!: string | null;

  @Prop({ type: String, required: true })
  address!: string;

  @Prop({ type: GeoPointSchema, required: true })
  location!: GeoPoint;

  @Prop({ type: String, default: null })
  phone!: string | null;

  @Prop({ type: String, default: null })
  website!: string | null;

  /** Why the applicant runs this restaurant; read by the reviewing admin. */
  @Prop({ type: String, required: true })
  statement!: string;

  @Prop({
    type: String,
    enum: Object.values(VerificationStatus),
    required: true,
    default: VerificationStatus.PENDING,
  })
  status!: VerificationStatus;

  @Prop({ type: String, default: null })
  reviewNote!: string | null;

  @Prop({ type: String, default: null })
  reviewedById!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);
WorkspaceSchema.index({ status: 1, createdAt: 1 });
WorkspaceSchema.index(
  { pageUserId: 1 },
  {
    unique: true,
    partialFilterExpression: { pageUserId: { $type: 'string' } },
  },
);
WorkspaceSchema.index({ location: '2dsphere' });

cascadeOnDelete(WorkspaceSchema, [
  { model: 'WorkspaceMember', field: 'workspaceId', action: 'delete' },
  { model: 'WorkspaceProof', field: 'workspaceId', action: 'unset' },
  { model: 'RestaurantMenuItem', field: 'workspaceId', action: 'delete' },
  { model: 'RestaurantReview', field: 'workspaceId', action: 'delete' },
]);

@Schema(collectionSchema('workspace_members', 'created'))
export class WorkspaceMember extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  workspaceId!: string;

  /** Copied from the workspace on approval, so a page session is checked with one lookup. */
  @Prop({ type: String, default: null })
  pageUserId!: string | null;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({
    type: String,
    enum: Object.values(WorkspaceMemberRole),
    required: true,
  })
  role!: WorkspaceMemberRole;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const WorkspaceMemberSchema =
  SchemaFactory.createForClass(WorkspaceMember);
WorkspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
WorkspaceMemberSchema.index({ userId: 1, createdAt: 1 });
WorkspaceMemberSchema.index(
  { pageUserId: 1, userId: 1 },
  { partialFilterExpression: { pageUserId: { $type: 'string' } } },
);

@Schema(collectionSchema('workspace_proofs', 'created'))
export class WorkspaceProof extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, default: null })
  ownerId!: string | null;

  /** Null until the proof is attached to an application. */
  @Prop({ type: String, default: null })
  workspaceId!: string | null;

  @Prop({ type: String, required: true })
  storageKey!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const WorkspaceProofSchema =
  SchemaFactory.createForClass(WorkspaceProof);
WorkspaceProofSchema.index({ storageKey: 1 }, { unique: true });
WorkspaceProofSchema.index({ ownerId: 1, workspaceId: 1 });
WorkspaceProofSchema.index({ workspaceId: 1, createdAt: 1 });

@Schema(collectionSchema('restaurant_menu_items'))
export class RestaurantMenuItem extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  workspaceId!: string;

  @Prop({ type: String, default: null })
  pageUserId!: string | null;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: String, default: null })
  description!: string | null;

  @Prop({ type: String, default: null })
  category!: string | null;

  @Prop({ type: Number, default: null })
  priceVnd!: number | null;

  @Prop({ type: String, default: null })
  imageUrl!: string | null;

  @Prop({ type: Boolean, required: true, default: true })
  isAvailable!: boolean;

  @Prop({ type: Number, required: true, default: 0 })
  position!: number;

  @Prop({ type: Date, default: null })
  searchIndexedAt!: Date | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const RestaurantMenuItemSchema =
  SchemaFactory.createForClass(RestaurantMenuItem);
RestaurantMenuItemSchema.index({
  workspaceId: 1,
  position: 1,
  createdAt: 1,
  _id: 1,
});
RestaurantMenuItemSchema.index({
  pageUserId: 1,
  isAvailable: 1,
  position: 1,
  createdAt: 1,
  _id: 1,
});
RestaurantMenuItemSchema.index({
  pageUserId: 1,
  isAvailable: 1,
  searchIndexedAt: 1,
});

@Schema(collectionSchema('restaurant_reviews'))
export class RestaurantReview extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  workspaceId!: string;

  @Prop({ type: String, required: true })
  pageUserId!: string;

  @Prop({ type: String, required: true })
  authorId!: string;

  @Prop({ type: Number, required: true })
  rating!: number;

  @Prop({ type: String, default: null })
  comment!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const RestaurantReviewSchema =
  SchemaFactory.createForClass(RestaurantReview);
RestaurantReviewSchema.index({ pageUserId: 1, authorId: 1 }, { unique: true });
RestaurantReviewSchema.index({ pageUserId: 1, createdAt: -1, _id: -1 });
RestaurantReviewSchema.index({
  pageUserId: 1,
  rating: -1,
  createdAt: -1,
  _id: -1,
});
RestaurantReviewSchema.index({ workspaceId: 1 });
RestaurantReviewSchema.index({ authorId: 1 });
