import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';

import type { Model, QueryFilter } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination/index.js';
import { lockDocument } from '../mongo/document-lock.js';
import {
  User,
  VerificationProof,
  VerificationRequest,
  VerificationStatus,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import {
  AdminVerificationRequestDetailDto,
  AdminVerificationRequestDto,
  CreateProofUploadDto,
  CreateVerificationRequestDto,
  MyVerificationDto,
  ProofUploadDto,
  ReviewVerificationRequestDto,
  VerificationRequestDto,
  VerificationRequestsQueryDto,
} from './dto/verification.dto.js';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
/** Uploads a user may hold without submitting them. */
const MAX_UNSUBMITTED_PROOFS = 12;
const CLEANUP_AGE_MS = 48 * 60 * 60 * 1000;
const PROOF_URL_TTL_SECONDS = 10 * 60;

const pendingConflict = () =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    code: 'REQUEST_PENDING',
    message: 'A verification request is already being reviewed',
  });

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @InjectModel(VerificationRequest.name)
    private readonly requests: Model<VerificationRequest>,
    @InjectModel(VerificationProof.name)
    private readonly proofs: Model<VerificationProof>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
    private readonly storage: StorageService,
  ) {}

  async createProofUpload(
    ownerId: string,
    dto: CreateProofUploadDto,
  ): Promise<ProofUploadDto> {
    if (dto.sizeBytes > MAX_PROOF_BYTES)
      throw new PayloadTooLargeException('Proof image is too large');
    const unsubmitted = await this.proofs.countDocuments({
      ownerId,
      requestId: null,
    });
    if (unsubmitted >= MAX_UNSUBMITTED_PROOFS)
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'PROOF_LIMIT_REACHED',
          message: 'Too many unsubmitted proof images; try again later',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const id = randomUUID();
    const key = `verifications/${ownerId}/${id}.${IMAGE_EXTENSIONS[dto.contentType]}`;
    const upload = await this.storage.presignUpload(
      StorageTarget.Verifications,
      key,
      dto.contentType,
      dto.sizeBytes,
    );
    await this.proofs.create({ _id: id, ownerId, storageKey: key });
    return { id, upload };
  }

  async submit(
    userId: string,
    dto: CreateVerificationRequestDto,
  ): Promise<VerificationRequestDto> {
    const proofs = await this.proofs
      .find({ ownerId: userId, requestId: null, _id: { $in: dto.proofIds } })
      .exec();
    if (proofs.length !== dto.proofIds.length)
      throw new BadRequestException('Unknown proof image');
    const uploaded = await Promise.all(
      proofs.map((proof) =>
        this.storage.exists(StorageTarget.Verifications, proof.storageKey),
      ),
    );
    if (uploaded.includes(false))
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        code: 'PROOF_NOT_UPLOADED',
        message: 'A proof image has not finished uploading',
      });

    const requestId = randomUUID();
    await this.mongo.withTransaction(async (session) => {
      // Two submits at once must not both see "no pending request".
      await lockDocument(this.mongo, session, 'user', userId);
      const user = await this.users
        .findOne({ _id: userId })
        .session(session)
        .exec();
      if (!user) throw new NotFoundException('User not found');
      if (user.isProfessional)
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          code: 'ALREADY_VERIFIED',
          message: 'This account is already verified',
        });
      const pending = await this.requests
        .findOne({ userId, status: VerificationStatus.PENDING })
        .session(session)
        .exec();
      if (pending) throw pendingConflict();
      await this.requests.create(
        [
          {
            _id: requestId,
            userId,
            statement: dto.statement,
            status: VerificationStatus.PENDING,
            reviewNote: null,
            reviewedById: null,
            reviewedAt: null,
          },
        ],
        { session },
      );
      // Claims only proofs still unsubmitted, so a concurrent submit of
      // the same images fails instead of sharing them.
      const claimed = await this.proofs.updateMany(
        { _id: { $in: dto.proofIds }, ownerId: userId, requestId: null },
        { $set: { requestId } },
        { session },
      );
      if (claimed.modifiedCount !== dto.proofIds.length)
        throw new BadRequestException('Unknown proof image');
    });
    const request = await this.requests.findOne({ _id: requestId }).exec();
    if (!request) throw new NotFoundException('Verification request not found');
    const [created] = await this.toDtos([request]);
    return created;
  }

  async mine(userId: string): Promise<MyVerificationDto> {
    const user = await this.users
      .findOne({ _id: userId })
      .select('isProfessional')
      .exec();
    if (!user) throw new NotFoundException('User not found');
    const latest = await this.requests
      .findOne({ userId })
      .sort({ createdAt: -1 })
      .exec();
    const [request] = latest ? await this.toDtos([latest]) : [];
    return { isProfessional: user.isProfessional, request: request ?? null };
  }

  async findAll(
    query: VerificationRequestsQueryDto,
  ): Promise<PaginatedResponseDto<AdminVerificationRequestDto>> {
    const { skip, take } = getPaginationArgs(query);
    const filter: QueryFilter<VerificationRequest> = {};
    if (query.status) filter.status = query.status;
    const [rows, totalItems] = await Promise.all([
      this.requests
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.requests.countDocuments(filter),
    ]);
    return createPaginatedResponse(
      await this.toAdminDtos(rows),
      totalItems,
      query,
    );
  }

  async findOne(id: string): Promise<AdminVerificationRequestDetailDto> {
    const row = await this.requests.findOne({ _id: id }).exec();
    if (!row) throw new NotFoundException('Verification request not found');
    const [[dto], proofs] = await Promise.all([
      this.toAdminDtos([row]),
      this.proofs.find({ requestId: id }).sort({ createdAt: 1, _id: 1 }).exec(),
    ]);
    return {
      ...dto,
      proofs: await Promise.all(
        proofs.map(async (proof) => ({
          id: proof.id,
          url: await this.storage.presignDownload(
            StorageTarget.Verifications,
            proof.storageKey,
            PROOF_URL_TTL_SECONDS,
          ),
        })),
      ),
    };
  }

  async review(
    id: string,
    reviewerId: string,
    dto: ReviewVerificationRequestDto,
  ): Promise<AdminVerificationRequestDto> {
    // The decision and the badge it grants are written together.
    await this.mongo.withTransaction(async (session) => {
      const now = new Date();
      const reviewed = await this.requests.updateOne(
        { _id: id, status: VerificationStatus.PENDING },
        {
          $set: {
            status: dto.decision,
            reviewNote: dto.note || null,
            reviewedById: reviewerId,
            reviewedAt: now,
          },
        },
        { session },
      );
      const request = await this.requests
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!request)
        throw new NotFoundException('Verification request not found');
      if (reviewed.modifiedCount === 0)
        throw new ConflictException('This request was already reviewed');
      if (dto.decision === VerificationStatus.APPROVED)
        await this.users.updateOne(
          { _id: request.userId },
          { $set: { isProfessional: true } },
          { session },
        );
    });
    const row = await this.requests.findOne({ _id: id }).exec();
    if (!row) throw new NotFoundException('Verification request not found');
    const [decided] = await this.toAdminDtos([row]);
    return decided;
  }

  /** Deletes images that were uploaded but never submitted, or whose request is gone. */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeUnusedProofs(): Promise<void> {
    if (!this.storage.isConfigured()) return;
    const proofs = await this.proofs
      .find({
        requestId: null,
        createdAt: { $lt: new Date(Date.now() - CLEANUP_AGE_MS) },
      })
      .sort({ createdAt: 1 })
      .limit(200)
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

  /** Adds how many proof images each request has. */
  private async toDtos(
    rows: VerificationRequest[],
  ): Promise<VerificationRequestDto[]> {
    const counts = await this.proofs
      .aggregate<{ _id: string; count: number }>([
        { $match: { requestId: { $in: rows.map(({ id }) => id) } } },
        { $group: { _id: '$requestId', count: { $sum: 1 } } },
      ])
      .exec();
    const proofCount = new Map(counts.map((row) => [row._id, row.count]));
    return rows.map((row) => ({
      id: row.id,
      statement: row.statement,
      status: row.status,
      reviewNote: row.reviewNote,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      proofCount: proofCount.get(row.id) ?? 0,
    }));
  }

  /** Adds the applicant. */
  private async toAdminDtos(
    rows: VerificationRequest[],
  ): Promise<AdminVerificationRequestDto[]> {
    const [dtos, users] = await Promise.all([
      this.toDtos(rows),
      this.users
        .find({ _id: { $in: rows.map(({ userId }) => userId) } })
        .exec(),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    return dtos.flatMap((dto, index) => {
      const user = userById.get(rows[index].userId);
      if (!user) return [];
      return [
        {
          ...dto,
          user: {
            id: user.id,
            username: user.username,
            fullName: user.fullName,
            email: user.email,
            avatarUrl: user.avatarUrl,
          },
        },
      ];
    });
  }
}
