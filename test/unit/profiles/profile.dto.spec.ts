import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  FollowSuggestionReason,
  ProfileImageKind,
} from '../../../src/mongo/models.js';
import {
  FollowSuggestionDto,
  FollowSuggestionListDto,
  FollowSuggestionQueryDto,
  MAX_SUGGESTIONS,
} from '../../../src/profiles/dto/follow-suggestion.dto.js';
import {
  CreateProfileImageUploadDto,
  PROFILE_IMAGE_TYPES,
  ProfileDto,
  ProfileImageUploadDto,
  ProfileListDto,
  ProfileRelationshipDto,
  ProfileSummaryDto,
  UpdateProfileDto,
} from '../../../src/profiles/dto/profile.dto.js';

describe('Profile and FollowSuggestion DTOs', () => {
  describe('FollowSuggestionQueryDto', () => {
    it('defaults limit to 5 when omitted', async () => {
      const dto = plainToInstance(FollowSuggestionQueryDto, {});

      expect(dto.limit).toBe(5);
      await expect(validate(dto)).resolves.toEqual([]);
    });

    it('transforms string numbers and accepts boundary values 1 and MAX_SUGGESTIONS', async () => {
      const minDto = plainToInstance(FollowSuggestionQueryDto, { limit: '1' });
      const maxDto = plainToInstance(FollowSuggestionQueryDto, {
        limit: String(MAX_SUGGESTIONS),
      });

      expect(minDto.limit).toBe(1);
      expect(maxDto.limit).toBe(MAX_SUGGESTIONS);
      await expect(validate(minDto)).resolves.toEqual([]);
      await expect(validate(maxDto)).resolves.toEqual([]);
    });

    it.each([0, -1, MAX_SUGGESTIONS + 1, 2.5, 'abc'])(
      'rejects invalid limit %p',
      async (limit) => {
        const dto = plainToInstance(FollowSuggestionQueryDto, { limit });

        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('limit');
      },
    );
  });

  describe('UpdateProfileDto', () => {
    it('accepts empty update, fullName + bio, and empty string bio to clear', async () => {
      const cases = [
        {},
        { fullName: 'Nguyen An', bio: 'Plant-based recipes' },
        { bio: '' },
        { fullName: 'A'.repeat(100), bio: 'B'.repeat(500) },
      ];

      for (const payload of cases) {
        const dto = plainToInstance(UpdateProfileDto, payload);
        await expect(validate(dto)).resolves.toEqual([]);
      }
    });

    it('rejects empty or oversized fullName and non-string values', async () => {
      for (const fullName of ['', 'A'.repeat(101), 123]) {
        const dto = plainToInstance(UpdateProfileDto, { fullName });
        const errors = await validate(dto);
        expect(errors[0].property).toBe('fullName');
      }
    });

    it('rejects oversized or non-string bio', async () => {
      for (const bio of ['B'.repeat(501), 42]) {
        const dto = plainToInstance(UpdateProfileDto, { bio });
        const errors = await validate(dto);
        expect(errors[0].property).toBe('bio');
      }
    });
  });

  describe('CreateProfileImageUploadDto', () => {
    it('accepts supported kinds, content types, and positive integer sizes', async () => {
      for (const contentType of PROFILE_IMAGE_TYPES) {
        for (const kind of [ProfileImageKind.AVATAR, ProfileImageKind.COVER]) {
          const dto = plainToInstance(CreateProfileImageUploadDto, {
            kind,
            contentType,
            sizeBytes: 1,
          });
          await expect(validate(dto)).resolves.toEqual([]);
        }
      }
    });

    it('rejects unsupported kind, contentType, and invalid sizeBytes', async () => {
      const invalidKind = plainToInstance(CreateProfileImageUploadDto, {
        kind: 'BANNER',
        contentType: 'image/webp',
        sizeBytes: 100,
      });
      const invalidMime = plainToInstance(CreateProfileImageUploadDto, {
        kind: ProfileImageKind.AVATAR,
        contentType: 'image/gif',
        sizeBytes: 100,
      });
      const zeroSize = plainToInstance(CreateProfileImageUploadDto, {
        kind: ProfileImageKind.AVATAR,
        contentType: 'image/png',
        sizeBytes: 0,
      });
      const floatSize = plainToInstance(CreateProfileImageUploadDto, {
        kind: ProfileImageKind.AVATAR,
        contentType: 'image/jpeg',
        sizeBytes: 10.5,
      });

      expect((await validate(invalidKind))[0].property).toBe('kind');
      expect((await validate(invalidMime))[0].property).toBe('contentType');
      expect((await validate(zeroSize))[0].property).toBe('sizeBytes');
      expect((await validate(floatSize))[0].property).toBe('sizeBytes');
    });
  });

  describe('response DTO classes', () => {
    it('instantiates profile and suggestion response DTOs', () => {
      const summary = new ProfileSummaryDto();
      const profile = new ProfileDto();
      const list = new ProfileListDto();
      const relationship = new ProfileRelationshipDto();
      const upload = new ProfileImageUploadDto();
      const suggestion = new FollowSuggestionDto();
      suggestion.reason = FollowSuggestionReason.FOLLOWS_YOU;
      const suggestionList = new FollowSuggestionListDto();

      expect(summary).toBeInstanceOf(ProfileSummaryDto);
      expect(profile).toBeInstanceOf(ProfileDto);
      expect(list).toBeInstanceOf(ProfileListDto);
      expect(relationship).toBeInstanceOf(ProfileRelationshipDto);
      expect(upload).toBeInstanceOf(ProfileImageUploadDto);
      expect(suggestion).toBeInstanceOf(FollowSuggestionDto);
      expect(suggestionList).toBeInstanceOf(FollowSuggestionListDto);
    });
  });
});
