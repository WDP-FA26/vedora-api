import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { VerificationStatus } from '../../../src/mongo/models.js';
import {
  AdminVerificationRequestDetailDto,
  AdminVerificationRequestDto,
  CreateProofUploadDto,
  CreateVerificationRequestDto,
  MAX_PROOFS,
  MAX_REVIEW_NOTE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MIN_STATEMENT_LENGTH,
  MyVerificationDto,
  PROOF_IMAGE_TYPES,
  ProofUploadDto,
  ReviewVerificationRequestDto,
  VerificationApplicantDto,
  VerificationProofDto,
  VerificationRequestDto,
  VerificationRequestsQueryDto,
} from '../../../src/verification/dto/verification.dto.js';

describe('Verification DTOs', () => {
  describe('CreateProofUploadDto', () => {
    it('accepts all allowed proof image types with positive integer sizeBytes', async () => {
      for (const contentType of PROOF_IMAGE_TYPES) {
        const dto = plainToInstance(CreateProofUploadDto, {
          contentType,
          sizeBytes: 1,
        });
        await expect(validate(dto)).resolves.toEqual([]);
      }
    });

    it('rejects unsupported content types and non-positive or non-integer sizes', async () => {
      const badType = plainToInstance(CreateProofUploadDto, {
        contentType: 'application/pdf',
        sizeBytes: 100,
      });
      const zeroSize = plainToInstance(CreateProofUploadDto, {
        contentType: 'image/png',
        sizeBytes: 0,
      });
      const floatSize = plainToInstance(CreateProofUploadDto, {
        contentType: 'image/jpeg',
        sizeBytes: 1.5,
      });

      expect((await validate(badType))[0].property).toBe('contentType');
      expect((await validate(zeroSize))[0].property).toBe('sizeBytes');
      expect((await validate(floatSize))[0].property).toBe('sizeBytes');
    });
  });

  describe('CreateVerificationRequestDto', () => {
    const validProof = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';

    it('trims statement and accepts boundary lengths and 1..MAX_PROOFS unique UUID v4 ids', async () => {
      const dto = plainToInstance(CreateVerificationRequestDto, {
        statement: `  ${'A'.repeat(MIN_STATEMENT_LENGTH)}  `,
        proofIds: Array.from({ length: MAX_PROOFS }, () => randomUUID()),
      });

      expect(dto.statement).toBe('A'.repeat(MIN_STATEMENT_LENGTH));
      await expect(validate(dto)).resolves.toEqual([]);

      const maxStatement = plainToInstance(CreateVerificationRequestDto, {
        statement: 'B'.repeat(MAX_STATEMENT_LENGTH),
        proofIds: [validProof],
      });
      await expect(validate(maxStatement)).resolves.toEqual([]);
    });

    it('rejects short, oversized, or non-string statement', async () => {
      const shortTrimmed = plainToInstance(CreateVerificationRequestDto, {
        statement: `   ${'A'.repeat(MIN_STATEMENT_LENGTH - 1)}   `,
        proofIds: [validProof],
      });
      const tooLong = plainToInstance(CreateVerificationRequestDto, {
        statement: 'A'.repeat(MAX_STATEMENT_LENGTH + 1),
        proofIds: [validProof],
      });
      const nonString = plainToInstance(CreateVerificationRequestDto, {
        statement: 12345,
        proofIds: [validProof],
      });

      expect((await validate(shortTrimmed))[0].property).toBe('statement');
      expect((await validate(tooLong))[0].property).toBe('statement');
      expect((await validate(nonString))[0].property).toBe('statement');
    });

    it('rejects empty, oversized, duplicate, or non-UUIDv4 proofIds', async () => {
      const empty = plainToInstance(CreateVerificationRequestDto, {
        statement: 'A'.repeat(MIN_STATEMENT_LENGTH),
        proofIds: [],
      });
      const tooMany = plainToInstance(CreateVerificationRequestDto, {
        statement: 'A'.repeat(MIN_STATEMENT_LENGTH),
        proofIds: Array.from({ length: MAX_PROOFS + 1 }, () => randomUUID()),
      });
      const duplicate = plainToInstance(CreateVerificationRequestDto, {
        statement: 'A'.repeat(MIN_STATEMENT_LENGTH),
        proofIds: [validProof, validProof],
      });
      const invalidUuid = plainToInstance(CreateVerificationRequestDto, {
        statement: 'A'.repeat(MIN_STATEMENT_LENGTH),
        proofIds: ['not-a-uuid'],
      });

      for (const dto of [empty, tooMany, duplicate, invalidUuid]) {
        const errors = await validate(dto);
        expect(errors[0].property).toBe('proofIds');
      }
    });
  });

  describe('VerificationRequestsQueryDto', () => {
    it('defaults pagination and accepts optional status filter', async () => {
      const defaults = plainToInstance(VerificationRequestsQueryDto, {});
      expect(defaults.page).toBe(1);
      expect(defaults.limit).toBe(20);
      await expect(validate(defaults)).resolves.toEqual([]);

      const filtered = plainToInstance(VerificationRequestsQueryDto, {
        page: '2',
        limit: '10',
        status: VerificationStatus.PENDING,
      });
      expect(filtered.page).toBe(2);
      expect(filtered.limit).toBe(10);
      await expect(validate(filtered)).resolves.toEqual([]);
    });

    it('rejects unknown status values', async () => {
      const invalid = plainToInstance(VerificationRequestsQueryDto, {
        status: 'CANCELLED',
      });
      const errors = await validate(invalid);
      expect(errors[0].property).toBe('status');
    });
  });

  describe('ReviewVerificationRequestDto', () => {
    it('allows APPROVED without a note or with a whitespace-only note', async () => {
      const withoutNote = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.APPROVED,
      });
      const blankNote = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.APPROVED,
        note: '   ',
      });

      await expect(validate(withoutNote)).resolves.toEqual([]);
      await expect(validate(blankNote)).resolves.toEqual([]);
    });

    it('validates note when provided on APPROVED and requires non-empty trimmed note on REJECTED', async () => {
      const approvedWithNote = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.APPROVED,
        note: '  Verified culinary diploma  ',
      });
      expect(approvedWithNote.note).toBe('Verified culinary diploma');
      await expect(validate(approvedWithNote)).resolves.toEqual([]);

      const rejectedWithNote = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.REJECTED,
        note: '  Certificate expired  ',
      });
      expect(rejectedWithNote.note).toBe('Certificate expired');
      await expect(validate(rejectedWithNote)).resolves.toEqual([]);
    });

    it('rejects REJECTED without a non-empty note, oversized notes, non-string notes, and PENDING decision', async () => {
      const missingNote = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.REJECTED,
      });
      const blankNote = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.REJECTED,
        note: '   ',
      });
      const tooLongNote = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.APPROVED,
        note: 'N'.repeat(MAX_REVIEW_NOTE_LENGTH + 1),
      });
      const nonStringNote = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.APPROVED,
        note: 999,
      });
      const pendingDecision = plainToInstance(ReviewVerificationRequestDto, {
        decision: VerificationStatus.PENDING,
        note: 'Cannot set pending',
      });

      expect((await validate(missingNote))[0].property).toBe('note');
      expect((await validate(blankNote))[0].property).toBe('note');
      expect((await validate(tooLongNote))[0].property).toBe('note');
      expect((await validate(nonStringNote))[0].property).toBe('note');
      expect((await validate(pendingDecision))[0].property).toBe('decision');
    });
  });

  describe('response DTO classes', () => {
    it('instantiates response DTO classes', () => {
      expect(new ProofUploadDto()).toBeInstanceOf(ProofUploadDto);
      expect(new VerificationRequestDto()).toBeInstanceOf(
        VerificationRequestDto,
      );
      expect(new MyVerificationDto()).toBeInstanceOf(MyVerificationDto);
      expect(new VerificationApplicantDto()).toBeInstanceOf(
        VerificationApplicantDto,
      );
      expect(new AdminVerificationRequestDto()).toBeInstanceOf(
        AdminVerificationRequestDto,
      );
      expect(new VerificationProofDto()).toBeInstanceOf(VerificationProofDto);
      expect(new AdminVerificationRequestDetailDto()).toBeInstanceOf(
        AdminVerificationRequestDetailDto,
      );
    });
  });
});
