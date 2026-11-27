import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  BusinessForm,
  LegalEntityType,
  VegetarianLevel,
  VerificationStatus,
  WorkspaceMemberRole,
  WorkspaceProofKind,
  WorkspaceRejectReason,
} from '../enums.js';
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

/** Who stands behind the restaurant legally; checked by the reviewing admin. */
@Schema({ _id: false, versionKey: false })
export class WorkspaceLegal {
  @Prop({ type: String, enum: Object.values(LegalEntityType), required: true })
  entityType!: LegalEntityType;

  /** 10 digits (10-3 for a branch), or the 12-digit citizen ID that households and individuals use. */
  @Prop({ type: String, required: true })
  taxCode!: string;

  /** Company or household business name; null for an individual. */
  @Prop({ type: String, default: null })
  legalName!: string | null;

  /** Registered address, or the permanent address of an individual. */
  @Prop({ type: String, required: true })
  legalAddress!: string;

  @Prop({ type: String, required: true })
  representativeName!: string;

  @Prop({ type: String, required: true })
  contactEmail!: string;
}

export const WorkspaceLegalSchema =
  SchemaFactory.createForClass(WorkspaceLegal);

/** What the admin confirmed before approving; all true for an approval. */
@Schema({ _id: false, versionKey: false })
export class WorkspaceReviewChecklist {
  @Prop({ type: Boolean, required: true }) identityMatches!: boolean;
  @Prop({ type: Boolean, required: true }) taxCodeVerified!: boolean;
  @Prop({ type: Boolean, required: true }) storefrontMatches!: boolean;
  @Prop({ type: Boolean, required: true }) phoneConfirmed!: boolean;
}

export const WorkspaceReviewChecklistSchema = SchemaFactory.createForClass(
  WorkspaceReviewChecklist,
);

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

  /** An official province code (`VN_PROVINCES`). Null on applications made before the 3-step form. */
  @Prop({ type: String, default: null })
  provinceCode!: string | null;

  /** Official ward code; null on applications made before the ward dropdown. */
  @Prop({ type: String, default: null })
  wardCode!: string | null;

  /** Ward name: looked up from `wardCode`, or typed by hand on older applications. */
  @Prop({ type: String, default: null })
  ward!: string | null;

  @Prop({ type: String, enum: Object.values(BusinessForm), default: null })
  businessForm!: BusinessForm | null;

  @Prop({ type: String, enum: Object.values(VegetarianLevel), default: null })
  vegetarianLevel!: VegetarianLevel | null;

  /** The restaurant on Google Maps, ShopeeFood, Facebook…, for the admin to compare. */
  @Prop({ type: [String], required: true, default: [] })
  otherPlatformUrls!: string[];

  @Prop({ type: WorkspaceLegalSchema, default: null })
  legal!: WorkspaceLegal | null;

  /** When the applicant confirmed the details are true and agreed to the review. */
  @Prop({ type: Date, default: null })
  committedAt!: Date | null;

  /** Who the applicant is at this restaurant; optional since the 3-step form. */
  @Prop({ type: String, default: null })
  statement!: string | null;

  @Prop({
    type: String,
    enum: Object.values(VerificationStatus),
    required: true,
    default: VerificationStatus.PENDING,
  })
  status!: VerificationStatus;

  @Prop({ type: String, default: null })
  reviewNote!: string | null;

  @Prop({
    type: String,
    enum: Object.values(WorkspaceRejectReason),
    default: null,
  })
  rejectReason!: WorkspaceRejectReason | null;

  @Prop({ type: WorkspaceReviewChecklistSchema, default: null })
  reviewChecklist!: WorkspaceReviewChecklist | null;

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
// The admin's "this tax code already has a page" warning.
WorkspaceSchema.index(
  { 'legal.taxCode': 1 },
  { partialFilterExpression: { 'legal.taxCode': { $type: 'string' } } },
);

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

  @Prop({
    type: String,
    enum: Object.values(WorkspaceProofKind),
    required: true,
    default: WorkspaceProofKind.OTHER,
  })
  kind!: WorkspaceProofKind;

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
