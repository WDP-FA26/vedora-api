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
import { Prisma, VerificationStatus } from '@prisma/client';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, StorageTarget } from '../storage/storage.service';
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
} from './dto/verification.dto';

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

const requestSelect = {
  id: true,
  statement: true,
  status: true,
  reviewNote: true,
  reviewedAt: true,
  createdAt: true,
  _count: { select: { proofs: true } },
} satisfies Prisma.VerificationRequestSelect;
type RequestRow = Prisma.VerificationRequestGetPayload<{
  select: typeof requestSelect;
}>;

const adminRequestSelect = {
  ...requestSelect,
  user: {
    select: {
      id: true,
      username: true,
      fullName: true,
      email: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.VerificationRequestSelect;
type AdminRequestRow = Prisma.VerificationRequestGetPayload<{
  select: typeof adminRequestSelect;
}>;

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
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async createProofUpload(
    ownerId: string,
    dto: CreateProofUploadDto,
  ): Promise<ProofUploadDto> {
    if (dto.sizeBytes > MAX_PROOF_BYTES)
      throw new PayloadTooLargeException('Proof image is too large');
    const unsubmitted = await this.prisma.verificationProof.count({
      where: { ownerId, requestId: null },
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
    await this.prisma.verificationProof.create({
      data: { id, ownerId, storageKey: key },
    });
    return { id, upload };
  }

  async submit(
    userId: string,
    dto: CreateVerificationRequestDto,
  ): Promise<VerificationRequestDto> {
    const proofs = await this.prisma.verificationProof.findMany({
      where: { id: { in: dto.proofIds }, ownerId: userId, requestId: null },
    });
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

    const request = await this.prisma
      .$transaction(
        async (tx) => {
          const user = await tx.user.findUniqueOrThrow({
            where: { id: userId },
            select: {
              isProfessional: true,
              verificationRequests: {
                where: { status: VerificationStatus.PENDING },
                select: { id: true },
                take: 1,
              },
            },
          });
          if (user.isProfessional)
            throw new ConflictException({
              statusCode: HttpStatus.CONFLICT,
              code: 'ALREADY_VERIFIED',
              message: 'This account is already verified',
            });
          if (user.verificationRequests.length) throw pendingConflict();
          const created = await tx.verificationRequest.create({
            data: { userId, statement: dto.statement },
            select: { id: true },
          });
          // Claims only proofs still unsubmitted, so a concurrent submit of
          // the same images fails instead of sharing them.
          const claimed = await tx.verificationProof.updateMany({
            where: {
              id: { in: dto.proofIds },
              ownerId: userId,
              requestId: null,
            },
            data: { requestId: created.id },
          });
          if (claimed.count !== dto.proofIds.length)
            throw new BadRequestException('Unknown proof image');
          return tx.verificationRequest.findUniqueOrThrow({
            where: { id: created.id },
            select: requestSelect,
          });
        },
        // Two submits at once must not both see "no pending request".
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((error: unknown) => {
        // Lost a serialization race against another submit by the same user.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034'
        )
          throw pendingConflict();
        throw error;
      });
    return this.toDto(request);
  }

  async mine(userId: string): Promise<MyVerificationDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        isProfessional: true,
        verificationRequests: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: requestSelect,
        },
      },
    });
    const [request] = user.verificationRequests;
    return {
      isProfessional: user.isProfessional,
      request: request ? this.toDto(request) : null,
    };
  }

  async findAll(
    query: VerificationRequestsQueryDto,
  ): Promise<PaginatedResponseDto<AdminVerificationRequestDto>> {
    const where = query.status ? { status: query.status } : {};
    const [rows, totalItems] = await this.prisma.$transaction(
      [
        this.prisma.verificationRequest.findMany({
          where,
          select: adminRequestSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...getPaginationArgs(query),
        }),
        this.prisma.verificationRequest.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return createPaginatedResponse(
      rows.map((row) => this.toAdminDto(row)),
      totalItems,
      query,
    );
  }

  async findOne(id: string): Promise<AdminVerificationRequestDetailDto> {
    const row = await this.prisma.verificationRequest.findUnique({
      where: { id },
      select: {
        ...adminRequestSelect,
        proofs: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, storageKey: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Verification request not found');
    return {
      ...this.toAdminDto(row),
      proofs: await Promise.all(
        row.proofs.map(async (proof) => ({
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
    const row = await this.prisma.$transaction(async (tx) => {
      const reviewed = await tx.verificationRequest.updateMany({
        where: { id, status: VerificationStatus.PENDING },
        data: {
          status: dto.decision,
          reviewNote: dto.note || null,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
        },
      });
      const request = await tx.verificationRequest.findUnique({
        where: { id },
        select: { ...adminRequestSelect, userId: true },
      });
      if (!request)
        throw new NotFoundException('Verification request not found');
      if (reviewed.count === 0)
        throw new ConflictException('This request was already reviewed');
      if (dto.decision === VerificationStatus.APPROVED)
        await tx.user.update({
          where: { id: request.userId },
          data: { isProfessional: true },
        });
      return request;
    });
    return this.toAdminDto(row);
  }

  /** Deletes images that were uploaded but never submitted, or whose request is gone. */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeUnusedProofs(): Promise<void> {
    if (!this.storage.isConfigured()) return;
    const proofs = await this.prisma.verificationProof.findMany({
      where: {
        requestId: null,
        createdAt: { lt: new Date(Date.now() - CLEANUP_AGE_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
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
      await this.prisma.verificationProof.delete({ where: { id: proof.id } });
    }
  }

  private toDto(row: RequestRow): VerificationRequestDto {
    return {
      id: row.id,
      statement: row.statement,
      status: row.status,
      reviewNote: row.reviewNote,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      proofCount: row._count.proofs,
    };
  }

  private toAdminDto(row: AdminRequestRow): AdminVerificationRequestDto {
    return { ...this.toDto(row), user: row.user };
  }
}
