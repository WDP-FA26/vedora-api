import { runtimeConfig } from '../config/runtime-config.js';
import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, QueryFilter } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination/index.js';
import { MailService } from '../mail/mail.service.js';
import { lockDocument } from '../mongo/document-lock.js';
import {
  AccountStatus,
  AccountType,
  LegalEntityType,
  NotificationType,
  User,
  UserRole,
  VerificationStatus,
  Workspace,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceProof,
  WorkspaceRejectReason,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { rethrowAsStateConflict } from '../mongo/unique-conflict.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ProfileSearchIndexService } from '../profiles/search/profile-search-index.service.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import { RefreshTokensService } from '../auth/refresh-tokens.service.js';
import { isSystemAccount } from '../users/system-account.js';
import { RestaurantMenuService } from './restaurant-menu.service.js';
import { LEGACY_PROVINCE_CODES, wardName } from './vn-admin-units.js';
import {
  RestaurantReviewsService,
  type RestaurantRatingStats,
} from './restaurant-reviews.service.js';
import {
  AddWorkspaceMemberDto,
  AdminWorkspaceDetailDto,
  AdminWorkspaceDto,
  CreateWorkspaceDto,
  CreateWorkspaceProofUploadDto,
  MAX_RESTAURANTS_IN_VIEW,
  RestaurantDetailsDto,
  RestaurantLocationDto,
  RestaurantPinListDto,
  REQUIRED_PROOF_KINDS,
  RestaurantsInViewQueryDto,
  ReviewWorkspaceDto,
  WorkspaceLegalViewDto,
  WorkspaceWarningCode,
  WorkspaceWarningDto,
  WorkspaceDetailDto,
  WorkspaceDto,
  WorkspaceMemberDto,
  WorkspaceProofUploadDto,
  WorkspacesQueryDto,
} from './dto/workspace.dto.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { FileTooLargeException } from '../common/exceptions/file-too-large.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { QuotaReachedException } from '../common/exceptions/quota-reached.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_PROOF_BYTES = runtimeConfig.VERIFICATION_PROOF_MAX_MB * 1048576;
const MAX_UNSUBMITTED_PROOFS =
  runtimeConfig.VERIFICATION_MAX_UNSUBMITTED_PROOFS;
const CLEANUP_AGE_MS = runtimeConfig.VERIFICATION_CLEANUP_AGE_SECONDS * 1000;
const PROOF_URL_TTL_SECONDS = runtimeConfig.VERIFICATION_PROOF_URL_TTL_SECONDS;

const pageEmail = (workspaceId: string) =>
  `page-${workspaceId}@pages.vedora.invalid`;

const NEARBY_PAGE_METERS = 100;
const RECENT_REJECTION_MS = 30 * 24 * 3600 * 1000;
const MAX_WARNING_PAGES = 5;

const VIETNAMESE_COLLATOR = new Intl.Collator('vi', { numeric: true });

const WORKSPACE_REJECT_REASON_LABELS: Record<WorkspaceRejectReason, string> = {
  [WorkspaceRejectReason.BLURRY_DOCUMENTS]: 'Giấy tờ bị mờ hoặc thiếu',
  [WorkspaceRejectReason.TAX_CODE_MISMATCH]:
    'Mã số thuế không khớp tên pháp lý',
  [WorkspaceRejectReason.IDENTITY_MISMATCH]: 'CCCD không khớp người đứng tên',
  [WorkspaceRejectReason.STOREFRONT_MISMATCH]:
    'Ảnh mặt tiền không khớp địa chỉ',
  [WorkspaceRejectReason.UNREACHABLE]: 'Không liên lạc được qua số điện thoại',
  [WorkspaceRejectReason.NOT_VEGETARIAN]: 'Quán không phục vụ món chay',
  [WorkspaceRejectReason.DUPLICATE]: 'Trùng với trang đã có',
  [WorkspaceRejectReason.OTHER]: 'Lý do khác',
};

type PageUser = Pick<
  User,
  'id' | 'username' | 'fullName' | 'bio' | 'avatarUrl' | 'status'
>;

type PinPageSummary = Pick<
  User,
  'id' | 'username' | 'fullName' | 'avatarUrl' | 'status'
>;

type PinSource = {
  pageUserId: string | null;
  address: string;
  location: { coordinates: [number, number] };
  distanceMeters: number | null;
};

@Injectable()
export class WorkspacesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaces: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private readonly members: Model<WorkspaceMember>,
    @InjectModel(WorkspaceProof.name)
    private readonly proofs: Model<WorkspaceProof>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
    private readonly storage: StorageService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    @Optional() private readonly profileSearchIndex?: ProfileSearchIndexService,
    @Optional() private readonly reviews?: RestaurantReviewsService,
    @Optional() private readonly menu?: RestaurantMenuService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.remapLegacyProvinceCodes();
  }

  async remapLegacyProvinceCodes(): Promise<void> {
    const rows = await this.workspaces
      .find({ provinceCode: { $in: Object.keys(LEGACY_PROVINCE_CODES) } })
      .select('provinceCode')
      .exec();
    const updates = [];
    for (const row of rows) {
      if (row.provinceCode === null) continue;
      updates.push({
        updateOne: {
          filter: { _id: row.id, provinceCode: row.provinceCode },
          update: {
            $set: { provinceCode: LEGACY_PROVINCE_CODES[row.provinceCode] },
          },
        },
      });
    }
    if (updates.length === 0) return;
    await this.workspaces.bulkWrite(updates);
    this.logger.log(
      `Mapped ${updates.length} page applications to official province codes`,
    );
  }

  async createProofUpload(
    personId: string,
    dto: CreateWorkspaceProofUploadDto,
  ): Promise<WorkspaceProofUploadDto> {
    if (dto.sizeBytes > MAX_PROOF_BYTES)
      throw new FileTooLargeException(
        'FILE_TOO_LARGE',
        'Proof image is too large',
      );
    const unsubmitted = await this.proofs.countDocuments({
      ownerId: personId,
      workspaceId: null,
    });
    if (unsubmitted >= MAX_UNSUBMITTED_PROOFS)
      throw new QuotaReachedException(
        'PROOF_LIMIT_REACHED',
        'Too many unsubmitted proof images; try again later',
      );
    const id = randomUUID();
    const key = `workspaces/${personId}/${id}.${IMAGE_EXTENSIONS[dto.contentType]}`;
    const upload = await this.storage.presignUpload(
      StorageTarget.Verifications,
      key,
      dto.contentType,
      dto.sizeBytes,
    );
    await this.proofs.create({
      _id: id,
      ownerId: personId,
      storageKey: key,
      kind: dto.kind,
    });
    return { id, upload };
  }

  async create(
    personId: string,
    dto: CreateWorkspaceDto,
  ): Promise<WorkspaceDetailDto> {
    await this.assertApplicationProofs(personId, dto);
    const workspaceId = randomUUID();
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'user', personId);
      await this.assertNoOtherPending(session, personId, null);
      await this.assertUsernameFree(session, dto.username, null);
      await this.workspaces.create(
        [
          {
            _id: workspaceId,
            pageUserId: null,
            ...this.applicationFields(dto),
            ...PENDING_REVIEW,
          },
        ],
        { session },
      );
      await this.members.create(
        [
          {
            workspaceId,
            pageUserId: null,
            userId: personId,
            role: WorkspaceMemberRole.OWNER,
          },
        ],
        { session },
      );
      await this.claimProofs(session, personId, workspaceId, dto.proofIds);
    });
    return this.detail(personId, workspaceId);
  }

  async resubmit(
    personId: string,
    workspaceId: string,
    dto: CreateWorkspaceDto,
  ): Promise<WorkspaceDetailDto> {
    await this.assertApplicationProofs(personId, dto);
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'user', personId);
      await lockDocument(this.mongo, session, 'workspace', workspaceId);
      const workspace = await this.findWorkspace(session, workspaceId);
      await this.assertOwner(session, workspace.id, personId);
      if (workspace.status !== VerificationStatus.REJECTED)
        throw new StateConflictException(
          'WORKSPACE_NOT_REVIEWABLE',
          'Only a rejected page can be sent for review again',
        );
      await this.assertNoOtherPending(session, personId, workspace.id);
      await this.assertUsernameFree(session, dto.username, workspace.id);
      await this.workspaces.updateOne(
        { _id: workspace.id },
        { $set: { ...this.applicationFields(dto), ...PENDING_REVIEW } },
        { session },
      );
      await this.claimProofs(session, personId, workspace.id, dto.proofIds);
    });
    return this.detail(personId, workspaceId);
  }

  async mine(personId: string): Promise<WorkspaceDto[]> {
    const memberships = await this.members
      .find({ userId: personId })
      .sort({ createdAt: -1, _id: -1 })
      .exec();
    const workspaces = await this.workspaces
      .find({ _id: { $in: memberships.map((row) => row.workspaceId) } })
      .exec();
    const roles = new Map<string, WorkspaceMemberRole>();
    for (const membership of memberships)
      roles.set(membership.workspaceId, membership.role);
    const dtos = await this.toDtos(workspaces, roles);
    const order = memberships.map((row) => row.workspaceId);
    return dtos.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  async detail(
    personId: string,
    workspaceId: string,
  ): Promise<WorkspaceDetailDto> {
    const workspace = await this.workspaces
      .findOne({ _id: workspaceId })
      .exec();
    const membership = await this.members
      .findOne({ workspaceId, userId: personId })
      .exec();
    if (!workspace || !membership)
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    const [[dto], members] = await Promise.all([
      this.toDtos([workspace], new Map([[workspace.id, membership.role]])),
      this.memberDtos(workspace.id),
    ]);
    return { ...dto, members };
  }

  async updateDetails(
    personId: string,
    workspaceId: string,
    dto: RestaurantDetailsDto,
  ): Promise<WorkspaceDetailDto> {
    const membership = await this.members
      .exists({ workspaceId, userId: personId })
      .exec();
    if (!membership)
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    const current = await this.workspaces.findOne({ _id: workspaceId }).exec();
    if (!current)
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    if (
      current.status === VerificationStatus.APPROVED &&
      movesRestaurant(current, dto)
    )
      throw new StateConflictException(
        'LOCKED_AFTER_APPROVAL',
        'The address and map pin of an approved page cannot change; contact support',
      );
    const updated = await this.workspaces
      .findOneAndUpdate(
        { _id: workspaceId },
        { $set: this.restaurantFields(dto) },
        { returnDocument: 'after' },
      )
      .exec();
    if (updated?.status === VerificationStatus.APPROVED) {
      await this.menu?.markWorkspaceDirty(workspaceId);
    }
    return this.detail(personId, workspaceId);
  }

  async addMember(
    personId: string,
    workspaceId: string,
    dto: AddWorkspaceMemberDto,
  ): Promise<WorkspaceDetailDto> {
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'workspace', workspaceId);
      const workspace = await this.findWorkspace(session, workspaceId);
      await this.assertOwner(session, workspace.id, personId);
      if (
        workspace.status !== VerificationStatus.APPROVED ||
        !workspace.pageUserId
      )
        throw new StateConflictException(
          'WORKSPACE_NOT_APPROVED',
          'Managers can be added once the page is approved',
        );
      const user = await this.users
        .findOne({ username: dto.username })
        .select('status accountType emailVerifiedAt')
        .session(session)
        .exec();
      if (
        !user ||
        isSystemAccount(user.id) ||
        user.accountType !== AccountType.PERSONAL ||
        user.status !== AccountStatus.ACTIVE ||
        !user.emailVerifiedAt
      )
        throw new ResourceNotFoundException('NOT_FOUND', 'User not found');
      try {
        await this.members.create(
          [
            {
              workspaceId: workspace.id,
              pageUserId: workspace.pageUserId,
              userId: user.id,
              role: WorkspaceMemberRole.MANAGER,
            },
          ],
          { session },
        );
      } catch (error: unknown) {
        rethrowAsStateConflict(
          error,
          'ALREADY_MEMBER',
          'This person already manages the page',
        );
      }
    });
    return this.detail(personId, workspaceId);
  }

  async removeMember(
    personId: string,
    workspaceId: string,
    memberId: string,
  ): Promise<void> {
    const pageUserId = await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'workspace', workspaceId);
      const workspace = await this.findWorkspace(session, workspaceId);
      const [actor, target] = await Promise.all([
        this.members
          .findOne({ workspaceId, userId: personId })
          .session(session)
          .exec(),
        this.members
          .findOne({ workspaceId, userId: memberId })
          .session(session)
          .exec(),
      ]);
      if (!actor)
        throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
      if (!target)
        throw new ResourceNotFoundException('NOT_FOUND', 'Member not found');
      if (target.role === WorkspaceMemberRole.OWNER)
        throw new StateConflictException(
          'CONFLICT',
          'The owner cannot be removed from the page',
        );
      const leaving = personId === memberId;
      if (!leaving && actor.role !== WorkspaceMemberRole.OWNER)
        throw new AccessDeniedException(
          'WORKSPACE_OWNER_REQUIRED',
          'Only the owner can remove managers',
        );
      await this.members.deleteOne({ _id: target.id }, { session });
      return workspace.pageUserId;
    });
    if (pageUserId)
      await this.refreshTokens.revokePageSessions(pageUserId, memberId);
  }

  async adminList(
    query: WorkspacesQueryDto,
  ): Promise<PaginatedResponseDto<AdminWorkspaceDto>> {
    const { skip, take } = getPaginationArgs(query);
    const filter: QueryFilter<Workspace> = {};
    if (query.status) filter.status = query.status;
    const [rows, totalItems] = await Promise.all([
      this.workspaces
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.workspaces.countDocuments(filter),
    ]);
    return createPaginatedResponse(
      await this.toAdminDtos(rows),
      totalItems,
      query,
    );
  }

  async adminDetail(workspaceId: string): Promise<AdminWorkspaceDetailDto> {
    const workspace = await this.workspaces
      .findOne({ _id: workspaceId })
      .exec();
    if (!workspace)
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    const [[dto], proofs, warnings] = await Promise.all([
      this.toAdminDtos([workspace]),
      this.proofs.find({ workspaceId }).sort({ createdAt: 1, _id: 1 }).exec(),
      this.warnings(workspace),
    ]);
    const signed = await Promise.all(
      proofs.map(async (proof) => ({
        id: proof.id,
        kind: proof.kind,
        url: await this.storage.presignDownload(
          StorageTarget.Verifications,
          proof.storageKey,
          PROOF_URL_TTL_SECONDS,
        ),
      })),
    );
    return { ...dto, proofs: signed, warnings };
  }

  async review(
    workspaceId: string,
    reviewerId: string,
    dto: ReviewWorkspaceDto,
  ): Promise<AdminWorkspaceDto> {
    const outcome = await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'workspace', workspaceId);
      const workspace = await this.findWorkspace(session, workspaceId);
      if (workspace.status !== VerificationStatus.PENDING)
        throw new StateConflictException(
          'WORKSPACE_NOT_REVIEWABLE',
          'This page was already reviewed',
        );
      const approving = dto.decision === VerificationStatus.APPROVED;
      if (approving && workspace.legal && !isChecklistComplete(dto))
        throw new InvalidInputException(
          'CHECKLIST_INCOMPLETE',
          'Tick every checklist item before approving',
        );
      const now = new Date();
      const decision = {
        status: dto.decision,
        reviewNote: dto.note || null,
        rejectReason: approving ? null : (dto.rejectReason ?? null),
        reviewChecklist: dto.checklist ?? null,
        reviewedById: reviewerId,
        reviewedAt: now,
      };
      if (dto.decision === VerificationStatus.REJECTED) {
        await this.workspaces.updateOne(
          { _id: workspace.id },
          { $set: decision },
          { session },
        );
        return {
          approvedPageUserId: null,
          workspaceName: workspace.name,
          contactEmail: workspace.legal?.contactEmail ?? null,
        };
      }
      const pageUserId = await this.createPageAccount(session, workspace, now);
      await this.workspaces.updateOne(
        { _id: workspace.id },
        { $set: { ...decision, pageUserId } },
        { session },
      );
      await this.members.updateMany(
        { workspaceId: workspace.id },
        { $set: { pageUserId } },
        { session },
      );
      return {
        approvedPageUserId: pageUserId,
        workspaceName: workspace.name,
        contactEmail: workspace.legal?.contactEmail ?? null,
      };
    });
    if (outcome.approvedPageUserId) {
      this.profileSearchIndex?.schedule();
      await this.menu?.markWorkspaceDirty(
        workspaceId,
        outcome.approvedPageUserId,
      );
    }
    await this.notifyReviewOutcome(
      workspaceId,
      outcome.workspaceName,
      outcome.contactEmail,
      dto,
    );
    const row = await this.workspaces.findOne({ _id: workspaceId }).exec();
    if (!row)
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    const [reviewed] = await this.toAdminDtos([row]);
    return reviewed;
  }

  private async notifyReviewOutcome(
    workspaceId: string,
    workspaceName: string,
    contactEmail: string | null,
    dto: ReviewWorkspaceDto,
  ): Promise<void> {
    const ownerMember = await this.members
      .findOne({ workspaceId, role: WorkspaceMemberRole.OWNER })
      .select('userId')
      .exec();
    const approving = dto.decision === VerificationStatus.APPROVED;
    const note = dto.note || null;
    const rejectReason = approving ? null : (dto.rejectReason ?? null);

    if (ownerMember) {
      await this.notifications.notify({
        recipientId: ownerMember.userId,
        type: approving
          ? NotificationType.WORKSPACE_APPROVED
          : NotificationType.WORKSPACE_REJECTED,
        workspaceId,
        reason: rejectReason ?? undefined,
        note: note ?? undefined,
      });
    }

    const recipients = await this.reviewEmailRecipients(
      ownerMember?.userId ?? null,
      contactEmail,
    );
    if (recipients.length === 0) return;

    const frontendUrl = this.config.getOrThrow<string>('FRONTEND_URL');
    const workspaceUrl = new URL(
      `/home/pages/${workspaceId}`,
      frontendUrl,
    ).toString();
    const rejectReasonLabel = rejectReason
      ? WORKSPACE_REJECT_REASON_LABELS[rejectReason]
      : null;

    for (const email of recipients) {
      try {
        await this.mail.sendWorkspaceReviewResult(email, {
          decision: approving ? 'APPROVED' : 'REJECTED',
          workspaceName,
          workspaceUrl,
          rejectReasonLabel,
          note,
        });
      } catch (error: unknown) {
        this.logger.warn(
          `Could not email workspace review outcome for ${workspaceId} to ${email}: ${String(error)}`,
        );
      }
    }
  }

  private async reviewEmailRecipients(
    ownerId: string | null,
    contactEmail: string | null,
  ): Promise<string[]> {
    const recipients: string[] = [];
    const seen = new Set<string>();
    const addEmail = (value: string | null | undefined) => {
      if (!value) return;
      const normalized = value.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      recipients.push(value.trim());
    };

    if (ownerId) {
      const owner = await this.users
        .findOne({ _id: ownerId })
        .select('email status emailVerifiedAt')
        .exec();
      if (owner && owner.status === AccountStatus.ACTIVE && owner.emailVerifiedAt) {
        addEmail(owner.email);
      }
    }
    addEmail(contactEmail);
    return recipients;
  }

  async inView(
    query: RestaurantsInViewQueryDto,
  ): Promise<RestaurantPinListDto> {
    const viewportLocationFilter = this.viewportFilter(query);

    if (query.userLng !== undefined && query.userLat !== undefined) {
      return this.restaurantsNearest(
        query.userLng,
        query.userLat,
        viewportLocationFilter,
      );
    }
    return this.restaurantsAlphabetical(viewportLocationFilter);
  }

  private viewportFilter(query: RestaurantsInViewQueryDto) {
    if (
      query.minLng === undefined ||
      query.minLat === undefined ||
      query.maxLng === undefined ||
      query.maxLat === undefined
    ) {
      return undefined;
    }
    if (query.minLat > query.maxLat) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'minLat must not be greater than maxLat',
      );
    }
    const wrapsAntimeridian = query.minLng > query.maxLng;
    const spansHemisphere = query.maxLng - query.minLng >= 180;
    if (wrapsAntimeridian || spansHemisphere) return undefined;
    return {
      $geoWithin: {
        $geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [query.minLng, query.minLat],
              [query.maxLng, query.minLat],
              [query.maxLng, query.maxLat],
              [query.minLng, query.maxLat],
              [query.minLng, query.minLat],
            ],
          ],
        },
      },
    };
  }

  private async restaurantsNearest(
    userLng: number,
    userLat: number,
    viewportLocationFilter: ReturnType<WorkspacesService['viewportFilter']>,
  ): Promise<RestaurantPinListDto> {
    const aggregated = await this.workspaces
      .aggregate<Workspace & { distanceMeters: number }>([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [userLng, userLat] },
            distanceField: 'distanceMeters',
            spherical: true,
            query: {
              status: VerificationStatus.APPROVED,
              pageUserId: { $type: 'string' },
            },
          },
        },
        ...(viewportLocationFilter
          ? [{ $match: { location: viewportLocationFilter } }]
          : []),
        { $limit: MAX_RESTAURANTS_IN_VIEW + 1 },
      ])
      .exec();

    const truncated = aggregated.length > MAX_RESTAURANTS_IN_VIEW;
    const visible = aggregated.slice(0, MAX_RESTAURANTS_IN_VIEW);
    const pageUserIds: string[] = [];
    const rows: PinSource[] = [];
    for (const doc of visible) {
      if (typeof doc.pageUserId === 'string') pageUserIds.push(doc.pageUserId);
      rows.push({
        pageUserId: doc.pageUserId,
        address: doc.address,
        location: doc.location,
        distanceMeters: Math.round(doc.distanceMeters),
      });
    }

    const [pageUserRows, ratingStats] = await Promise.all([
      pageUserIds.length > 0
        ? this.users
            .find({ _id: { $in: pageUserIds }, status: AccountStatus.ACTIVE })
            .select('username fullName avatarUrl status')
            .exec()
        : Promise.resolve([]),
      this.reviews
        ? this.reviews.summariesByPageUserIds(pageUserIds)
        : Promise.resolve(new Map<string, RestaurantRatingStats>()),
    ]);
    const pages = new Map<string, PinPageSummary>(
      pageUserRows.map((user) => [user.id, user]),
    );
    return {
      items: this.buildRestaurantPinItems(rows, pages, ratingStats),
      truncated,
    };
  }

  private async restaurantsAlphabetical(
    viewportLocationFilter: ReturnType<WorkspacesService['viewportFilter']>,
  ): Promise<RestaurantPinListDto> {
    const filter: QueryFilter<Workspace> = {
      status: VerificationStatus.APPROVED,
      pageUserId: { $type: 'string' },
      ...(viewportLocationFilter ? { location: viewportLocationFilter } : {}),
    };
    const found = await this.workspaces
      .find(filter)
      .select('pageUserId address location')
      .exec();

    const pageUserIds: string[] = [];
    for (const row of found) {
      if (typeof row.pageUserId === 'string') pageUserIds.push(row.pageUserId);
    }
    if (pageUserIds.length === 0) return { items: [], truncated: false };

    const pageUserRows = await this.users
      .find({ _id: { $in: pageUserIds }, status: AccountStatus.ACTIVE })
      .select('username fullName avatarUrl status')
      .exec();
    const pages = new Map<string, PinPageSummary>(
      pageUserRows.map((user) => [user.id, user]),
    );

    const active: Array<{ source: PinSource; page: PinPageSummary }> = [];
    for (const row of found) {
      if (!row.pageUserId) continue;
      const page = pages.get(row.pageUserId);
      if (!page) continue;
      active.push({
        source: {
          pageUserId: row.pageUserId,
          address: row.address,
          location: row.location,
          distanceMeters: null,
        },
        page,
      });
    }

    active.sort((a, b) => {
      const byName = VIETNAMESE_COLLATOR.compare(
        a.page.fullName,
        b.page.fullName,
      );
      if (byName !== 0) return byName;
      return a.page.id.localeCompare(b.page.id);
    });

    const truncated = active.length > MAX_RESTAURANTS_IN_VIEW;
    const visible = active.slice(0, MAX_RESTAURANTS_IN_VIEW);
    const visibleIds = visible.map((entry) => entry.page.id);
    const ratingStats = this.reviews
      ? await this.reviews.summariesByPageUserIds(visibleIds)
      : new Map<string, RestaurantRatingStats>();

    const rows = visible.map((entry) => entry.source);
    return {
      items: this.buildRestaurantPinItems(rows, pages, ratingStats),
      truncated,
    };
  }

  private buildRestaurantPinItems(
    rows: PinSource[],
    pages: Map<string, PinPageSummary>,
    ratingStats: Map<string, RestaurantRatingStats>,
  ): RestaurantPinListDto['items'] {
    const items: RestaurantPinListDto['items'] = [];
    for (const workspace of rows) {
      if (!workspace.pageUserId) continue;
      const page = pages.get(workspace.pageUserId);
      if (!page || page.status !== AccountStatus.ACTIVE) continue;
      const [longitude, latitude] = workspace.location.coordinates;
      const stats = ratingStats.get(page.id);
      items.push({
        pageUserId: page.id,
        username: page.username,
        name: page.fullName,
        avatarUrl: page.avatarUrl,
        address: workspace.address,
        longitude,
        latitude,
        distanceMeters: workspace.distanceMeters,
        averageRating: stats?.averageRating ?? null,
        reviewCount: stats?.reviewCount ?? 0,
      });
    }
    return items;
  }

  @Cron(runtimeConfig.VERIFICATION_CLEANUP_CRON)
  async purgeUnusedProofs(): Promise<void> {
    if (!this.storage.isConfigured()) return;
    const proofs = await this.proofs
      .find({
        workspaceId: null,
        createdAt: { $lt: new Date(Date.now() - CLEANUP_AGE_MS) },
      })
      .sort({ createdAt: 1 })
      .limit(runtimeConfig.VERIFICATION_CLEANUP_BATCH_SIZE)
      .exec();
    for (const proof of proofs) {
      try {
        await this.storage.delete(
          StorageTarget.Verifications,
          proof.storageKey,
        );
      } catch (error) {
        this.logger.warn(
          `Could not purge ${proof.storageKey}: ${String(error)}`,
        );
        continue;
      }
      await this.proofs.deleteOne({ _id: proof.id });
    }
  }

  private async createPageAccount(
    session: ClientSession,
    workspace: Workspace,
    now: Date,
  ): Promise<string> {
    const pageUserId = randomUUID();
    try {
      await this.users.create(
        [
          {
            _id: pageUserId,
            username: workspace.username,
            fullName: workspace.name,
            bio: workspace.bio,
            email: pageEmail(workspace.id),
            passwordHash: null,
            googleId: null,
            role: UserRole.USER,
            status: AccountStatus.ACTIVE,
            accountType: AccountType.PAGE,
            accountVersion: 0,
            isProfessional: false,
            emailVerifiedAt: now,
          },
        ],
        { session },
      );
    } catch (error: unknown) {
      rethrowAsStateConflict(
        error,
        'USERNAME_TAKEN',
        'This username was taken after the page applied; reject with a note so the owner picks another',
      );
    }
    return pageUserId;
  }

  private applicationFields(dto: CreateWorkspaceDto) {
    const { legal } = dto;
    return {
      username: dto.username,
      name: dto.name,
      bio: dto.bio ?? null,
      statement: dto.statement ?? null,
      ...this.restaurantFields(dto),
      provinceCode: dto.provinceCode,
      wardCode: dto.wardCode,
      ward: wardName(dto.provinceCode, dto.wardCode),
      businessForm: dto.businessForm,
      vegetarianLevel: dto.vegetarianLevel,
      otherPlatformUrls: dto.otherPlatformUrls ?? [],
      legal: {
        entityType: legal.entityType,
        taxCode: legal.taxCode,
        legalName: needsLegalName(legal.entityType)
          ? (legal.legalName ?? null)
          : null,
        legalAddress: legal.legalAddress,
        representativeName: legal.representativeName,
        contactEmail: legal.contactEmail,
      },
      committedAt: new Date(),
    };
  }

  private restaurantFields(dto: RestaurantDetailsDto | CreateWorkspaceDto) {
    return {
      address: dto.address,
      location: {
        type: 'Point' as const,
        coordinates: [dto.longitude, dto.latitude] satisfies [number, number],
      },
      phone: dto.phone ?? null,
      website: dto.website ?? null,
    };
  }

  private async assertApplicationProofs(
    personId: string,
    dto: CreateWorkspaceDto,
  ): Promise<void> {
    const proofs = await this.assertProofsUploaded(personId, dto.proofIds);
    const kinds = new Set(proofs.map(({ kind }) => kind));
    const missing = REQUIRED_PROOF_KINDS[dto.legal.entityType].filter(
      (kind) => !kinds.has(kind),
    );
    if (missing.length > 0)
      throw new InvalidInputException(
        'MISSING_PROOF',
        `Missing proof images: ${missing.join(', ')}`,
      );
  }

  private async assertNoOtherPending(
    session: ClientSession,
    personId: string,
    exceptWorkspaceId: string | null,
  ): Promise<void> {
    const owned = await this.members
      .find({ userId: personId, role: WorkspaceMemberRole.OWNER })
      .select('workspaceId')
      .session(session)
      .exec();
    const otherIds: string[] = [];
    for (const row of owned) {
      if (row.workspaceId !== exceptWorkspaceId) otherIds.push(row.workspaceId);
    }
    if (otherIds.length === 0) return;
    const pending = await this.workspaces
      .exists({ _id: { $in: otherIds }, status: VerificationStatus.PENDING })
      .session(session)
      .exec();
    if (pending)
      throw new StateConflictException(
        'APPLICATION_PENDING',
        'You already have an application waiting for review',
      );
  }

  private async assertProofsUploaded(
    personId: string,
    proofIds: string[],
  ): Promise<WorkspaceProof[]> {
    const proofs = await this.proofs
      .find({ ownerId: personId, workspaceId: null, _id: { $in: proofIds } })
      .exec();
    if (proofs.length !== proofIds.length)
      throw new InvalidInputException('BAD_REQUEST', 'Unknown proof image');
    const uploaded = await Promise.all(
      proofs.map((proof) =>
        this.storage.exists(StorageTarget.Verifications, proof.storageKey),
      ),
    );
    if (uploaded.includes(false))
      throw new StateConflictException(
        'PROOF_NOT_UPLOADED',
        'A proof image has not finished uploading',
      );
    return proofs;
  }

  private async warnings(workspace: Workspace): Promise<WorkspaceWarningDto[]> {
    const [sameTaxCode, nearby, recentRejections] = await Promise.all([
      this.sameTaxCodePages(workspace),
      this.nearbyPages(workspace),
      this.recentRejections(workspace),
    ]);
    const warnings: WorkspaceWarningDto[] = [];
    const found: Array<[WorkspaceWarningCode, Workspace[]]> = [
      [WorkspaceWarningCode.SAME_TAX_CODE, sameTaxCode],
      [WorkspaceWarningCode.NEARBY_PAGE, nearby],
      [WorkspaceWarningCode.RECENT_REJECTION, recentRejections],
    ];
    for (const [code, rows] of found) {
      if (rows.length === 0) continue;
      warnings.push({
        code,
        workspaces: rows.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
        })),
      });
    }
    return warnings;
  }

  private async sameTaxCodePages(workspace: Workspace): Promise<Workspace[]> {
    if (!workspace.legal) return [];
    return this.workspaces
      .find({
        _id: { $ne: workspace.id },
        'legal.taxCode': { $eq: workspace.legal.taxCode, $type: 'string' },
        status: VerificationStatus.APPROVED,
      })
      .select('name status')
      .limit(MAX_WARNING_PAGES)
      .exec();
  }

  private async nearbyPages(workspace: Workspace): Promise<Workspace[]> {
    return this.workspaces
      .find({
        _id: { $ne: workspace.id },
        status: VerificationStatus.APPROVED,
        location: {
          $nearSphere: {
            $geometry: workspace.location,
            $maxDistance: NEARBY_PAGE_METERS,
          },
        },
      })
      .select('name status')
      .limit(MAX_WARNING_PAGES)
      .exec();
  }

  private async recentRejections(workspace: Workspace): Promise<Workspace[]> {
    const owner = await this.members
      .findOne({ workspaceId: workspace.id, role: WorkspaceMemberRole.OWNER })
      .exec();
    if (!owner) return [];
    const owned = await this.members
      .find({ userId: owner.userId, role: WorkspaceMemberRole.OWNER })
      .select('workspaceId')
      .exec();
    const otherIds: string[] = [];
    for (const row of owned) {
      if (row.workspaceId !== workspace.id) otherIds.push(row.workspaceId);
    }
    if (otherIds.length === 0) return [];
    return this.workspaces
      .find({
        _id: { $in: otherIds },
        status: VerificationStatus.REJECTED,
        reviewedAt: { $gte: new Date(Date.now() - RECENT_REJECTION_MS) },
      })
      .select('name status')
      .limit(MAX_WARNING_PAGES)
      .exec();
  }

  private async claimProofs(
    session: ClientSession,
    personId: string,
    workspaceId: string,
    proofIds: string[],
  ): Promise<void> {
    const claimed = await this.proofs.updateMany(
      { _id: { $in: proofIds }, ownerId: personId, workspaceId: null },
      { $set: { workspaceId } },
      { session },
    );
    if (claimed.modifiedCount !== proofIds.length)
      throw new InvalidInputException('BAD_REQUEST', 'Unknown proof image');
  }

  private async assertUsernameFree(
    session: ClientSession,
    username: string,
    workspaceId: string | null,
  ): Promise<void> {
    const pendingFilter: QueryFilter<Workspace> = {
      username,
      status: VerificationStatus.PENDING,
    };
    if (workspaceId) pendingFilter._id = { $ne: workspaceId };
    const [user, pending] = await Promise.all([
      this.users.exists({ username }).session(session).exec(),
      this.workspaces.exists(pendingFilter).session(session).exec(),
    ]);
    if (user || pending)
      throw new StateConflictException(
        'USERNAME_TAKEN',
        'This username is already taken',
      );
  }

  private async findWorkspace(
    session: ClientSession,
    workspaceId: string,
  ): Promise<Workspace> {
    const workspace = await this.workspaces
      .findOne({ _id: workspaceId })
      .session(session)
      .exec();
    if (!workspace)
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    return workspace;
  }

  private async assertOwner(
    session: ClientSession,
    workspaceId: string,
    personId: string,
  ): Promise<void> {
    const membership = await this.members
      .findOne({ workspaceId, userId: personId })
      .session(session)
      .exec();
    if (!membership)
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    if (membership.role !== WorkspaceMemberRole.OWNER)
      throw new AccessDeniedException(
        'WORKSPACE_OWNER_REQUIRED',
        'Only the owner can do this',
      );
  }

  private async pageUsers(
    workspaces: Workspace[],
  ): Promise<Map<string, PageUser>> {
    const ids: string[] = [];
    for (const workspace of workspaces)
      if (workspace.pageUserId) ids.push(workspace.pageUserId);
    const users = await this.users
      .find({ _id: { $in: ids } })
      .select('username fullName bio avatarUrl status')
      .exec();
    return new Map(users.map((user) => [user.id, user]));
  }

  private async proofCounts(
    workspaces: Workspace[],
  ): Promise<Map<string, number>> {
    const counts = await this.proofs
      .aggregate<{ _id: string; count: number }>([
        { $match: { workspaceId: { $in: workspaces.map(({ id }) => id) } } },
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } },
      ])
      .exec();
    return new Map(counts.map((row) => [row._id, row.count]));
  }

  private locationDto(workspace: Workspace): RestaurantLocationDto {
    const [longitude, latitude] = workspace.location.coordinates;
    return {
      address: workspace.address,
      longitude,
      latitude,
      phone: workspace.phone,
      website: workspace.website,
    };
  }

  private async toDtos(
    workspaces: Workspace[],
    roles: Map<string, WorkspaceMemberRole>,
  ): Promise<WorkspaceDto[]> {
    const [pages, proofCounts] = await Promise.all([
      this.pageUsers(workspaces),
      this.proofCounts(workspaces),
    ]);
    const dtos: WorkspaceDto[] = [];
    for (const workspace of workspaces) {
      const role = roles.get(workspace.id);
      if (!role) continue;
      const page = workspace.pageUserId
        ? pages.get(workspace.pageUserId)
        : undefined;
      dtos.push({
        id: workspace.id,
        pageUserId: workspace.pageUserId,
        username: page?.username ?? workspace.username,
        name: page?.fullName ?? workspace.name,
        bio: page ? page.bio : workspace.bio,
        avatarUrl: page?.avatarUrl ?? null,
        status: workspace.status,
        reviewNote: workspace.reviewNote,
        rejectReason: workspace.rejectReason,
        reviewedAt: workspace.reviewedAt,
        createdAt: workspace.createdAt,
        proofCount: proofCounts.get(workspace.id) ?? 0,
        role,
        legal: role === WorkspaceMemberRole.OWNER ? legalView(workspace) : null,
        ...this.profileFields(workspace),
      });
    }
    return dtos;
  }

  private async memberDtos(workspaceId: string): Promise<WorkspaceMemberDto[]> {
    const rows = await this.members
      .find({ workspaceId })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    const users = await this.users
      .find({ _id: { $in: rows.map((row) => row.userId) } })
      .select('username fullName avatarUrl')
      .exec();
    const userById = new Map(users.map((user) => [user.id, user]));
    const dtos: WorkspaceMemberDto[] = [];
    for (const row of rows) {
      const user = userById.get(row.userId);
      if (!user) continue;
      dtos.push({
        userId: user.id,
        username: user.username,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        role: row.role,
        createdAt: row.createdAt,
      });
    }
    return dtos;
  }

  private async toAdminDtos(
    workspaces: Workspace[],
  ): Promise<AdminWorkspaceDto[]> {
    const workspaceIds = workspaces.map(({ id }) => id);
    const [proofCounts, owners] = await Promise.all([
      this.proofCounts(workspaces),
      this.members
        .find({
          workspaceId: { $in: workspaceIds },
          role: WorkspaceMemberRole.OWNER,
        })
        .exec(),
    ]);
    const ownerIdByWorkspace = new Map(
      owners.map((row) => [row.workspaceId, row.userId]),
    );
    const users = await this.users
      .find({ _id: { $in: owners.map((row) => row.userId) } })
      .select('username fullName email avatarUrl')
      .exec();
    const userById = new Map(users.map((user) => [user.id, user]));
    return workspaces.map((workspace) => {
      const ownerId = ownerIdByWorkspace.get(workspace.id);
      const owner = ownerId ? userById.get(ownerId) : undefined;
      return {
        id: workspace.id,
        pageUserId: workspace.pageUserId,
        username: workspace.username,
        name: workspace.name,
        bio: workspace.bio,
        status: workspace.status,
        reviewNote: workspace.reviewNote,
        rejectReason: workspace.rejectReason,
        reviewChecklist: workspace.reviewChecklist,
        reviewedAt: workspace.reviewedAt,
        createdAt: workspace.createdAt,
        committedAt: workspace.committedAt,
        proofCount: proofCounts.get(workspace.id) ?? 0,
        legal: legalView(workspace),
        owner: owner
          ? {
              id: owner.id,
              username: owner.username,
              fullName: owner.fullName,
              email: owner.email,
              avatarUrl: owner.avatarUrl,
            }
          : null,
        ...this.profileFields(workspace),
      };
    });
  }

  private profileFields(workspace: Workspace) {
    return {
      ...this.locationDto(workspace),
      provinceCode: workspace.provinceCode,
      wardCode: workspace.wardCode,
      ward: workspace.ward,
      businessForm: workspace.businessForm,
      vegetarianLevel: workspace.vegetarianLevel,
      otherPlatformUrls: workspace.otherPlatformUrls,
      statement: workspace.statement,
    };
  }
}

const PENDING_REVIEW = {
  status: VerificationStatus.PENDING,
  reviewNote: null,
  rejectReason: null,
  reviewChecklist: null,
  reviewedById: null,
  reviewedAt: null,
};

function needsLegalName(entityType: LegalEntityType): boolean {
  return entityType !== LegalEntityType.INDIVIDUAL;
}

function legalView(workspace: Workspace): WorkspaceLegalViewDto | null {
  const { legal } = workspace;
  if (!legal) return null;
  return {
    entityType: legal.entityType,
    taxCode: legal.taxCode,
    legalName: legal.legalName,
    legalAddress: legal.legalAddress,
    representativeName: legal.representativeName,
    contactEmail: legal.contactEmail,
  };
}

function isChecklistComplete(dto: ReviewWorkspaceDto): boolean {
  const { checklist } = dto;
  if (!checklist) return false;
  return (
    checklist.identityMatches &&
    checklist.taxCodeVerified &&
    checklist.storefrontMatches &&
    checklist.phoneConfirmed
  );
}

function movesRestaurant(
  current: Workspace,
  dto: RestaurantDetailsDto,
): boolean {
  const [longitude, latitude] = current.location.coordinates;
  return (
    current.address !== dto.address ||
    longitude !== dto.longitude ||
    latitude !== dto.latitude
  );
}
