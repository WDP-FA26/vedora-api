import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import { ProfileImageKind, UserRole } from '../../../src/mongo/models.js';
import type {
  FollowSuggestionListDto,
  FollowSuggestionQueryDto,
} from '../../../src/profiles/dto/follow-suggestion.dto.js';
import type {
  CreateProfileImageUploadDto,
  ProfileDto,
  ProfileImageUploadDto,
  ProfileListDto,
  ProfileRelationshipDto,
} from '../../../src/profiles/dto/profile.dto.js';
import type { FollowSuggestionsService } from '../../../src/profiles/follow-suggestions.service.js';
import { ProfilesController } from '../../../src/profiles/profiles.controller.js';
import type { ProfilesService } from '../../../src/profiles/profiles.service.js';

describe('ProfilesController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const otherId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
  const uploadId = 'b7f6f651-b0fc-43a5-b589-edbda60e5983';
  const request = {
    user: { sub: userId, username: 'vedora.user', role: UserRole.USER },
  } as AuthenticatedRequest;

  const profile: ProfileDto = {
    id: userId,
    username: 'vedora.user',
    fullName: 'Vedora User',
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    isProfessional: false,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    postCount: 2,
    followerCount: 3,
    followingCount: 4,
  };

  let profilesService: ReturnType<typeof mockDeep<ProfilesService>>;
  let suggestionsService: ReturnType<typeof mockDeep<FollowSuggestionsService>>;
  let controller: ProfilesController;

  beforeEach(() => {
    profilesService = mockDeep<ProfilesService>();
    suggestionsService = mockDeep<FollowSuggestionsService>();
    controller = new ProfilesController(profilesService, suggestionsService);
  });

  it('delegates me() to profiles.findOne with caller sub', async () => {
    profilesService.findOne.mockResolvedValue(profile);

    await expect(controller.me(request)).resolves.toBe(profile);
    expect(profilesService.findOne).toHaveBeenCalledExactlyOnceWith(userId);
  });

  it('delegates updateMe() with caller sub and dto', async () => {
    const dto = { fullName: 'New Name', bio: 'Plant lover' };
    profilesService.updateMe.mockResolvedValue(profile);

    await expect(controller.updateMe(request, dto)).resolves.toBe(profile);
    expect(profilesService.updateMe).toHaveBeenCalledExactlyOnceWith(
      userId,
      dto,
    );
  });

  it('delegates createImageUpload() with caller sub and dto', async () => {
    const dto: CreateProfileImageUploadDto = {
      kind: ProfileImageKind.AVATAR,
      contentType: 'image/webp',
      sizeBytes: 12000,
    };
    const upload: ProfileImageUploadDto = {
      id: uploadId,
      upload: {
        url: 'https://storage/put',
        method: 'PUT',
        headers: { 'content-type': 'image/webp' },
        expiresAt: new Date('2026-10-01T01:00:00Z'),
      },
    };
    profilesService.createImageUpload.mockResolvedValue(upload);

    await expect(controller.createImageUpload(request, dto)).resolves.toBe(
      upload,
    );
    expect(profilesService.createImageUpload).toHaveBeenCalledExactlyOnceWith(
      userId,
      dto,
    );
  });

  it('delegates activateImage() with caller sub and uploadId', async () => {
    profilesService.activateImage.mockResolvedValue(profile);

    await expect(controller.activateImage(request, uploadId)).resolves.toBe(
      profile,
    );
    expect(profilesService.activateImage).toHaveBeenCalledExactlyOnceWith(
      userId,
      uploadId,
    );
  });

  it('delegates clearImage() with caller sub and kind', async () => {
    profilesService.clearImage.mockResolvedValue(profile);

    await expect(
      controller.clearImage(request, ProfileImageKind.COVER),
    ).resolves.toBe(profile);
    expect(profilesService.clearImage).toHaveBeenCalledExactlyOnceWith(
      userId,
      ProfileImageKind.COVER,
    );
  });

  it('delegates suggestionsList() with caller sub and query.limit', async () => {
    const query: FollowSuggestionQueryDto = { limit: 7 };
    const list: FollowSuggestionListDto = { items: [] };
    suggestionsService.list.mockResolvedValue(list);

    await expect(controller.suggestionsList(request, query)).resolves.toBe(
      list,
    );
    expect(suggestionsService.list).toHaveBeenCalledExactlyOnceWith(userId, 7);
  });

  it('delegates dismissSuggestion() with caller sub and candidate id', async () => {
    suggestionsService.dismiss.mockResolvedValue(undefined);

    await expect(
      controller.dismissSuggestion(request, otherId),
    ).resolves.toBeUndefined();
    expect(suggestionsService.dismiss).toHaveBeenCalledExactlyOnceWith(
      userId,
      otherId,
    );
  });

  it('delegates followers() and following() with id and cursor query', async () => {
    const query = { limit: 10, cursor: otherId };
    const list: ProfileListDto = { items: [], nextCursor: null };
    profilesService.followers.mockResolvedValue(list);
    profilesService.following.mockResolvedValue(list);

    await expect(controller.followers(userId, query)).resolves.toBe(list);
    expect(profilesService.followers).toHaveBeenCalledExactlyOnceWith(
      userId,
      query,
    );

    await expect(controller.following(userId, query)).resolves.toBe(list);
    expect(profilesService.following).toHaveBeenCalledExactlyOnceWith(
      userId,
      query,
    );
  });

  it('delegates relationship() with target id and caller sub', async () => {
    const rel: ProfileRelationshipDto = { isFollowing: true };
    profilesService.relationship.mockResolvedValue(rel);

    await expect(controller.relationship(request, otherId)).resolves.toBe(rel);
    expect(profilesService.relationship).toHaveBeenCalledExactlyOnceWith(
      otherId,
      userId,
    );
  });

  it('delegates follow() and unfollow() with target id and caller sub', async () => {
    profilesService.follow.mockResolvedValue(undefined);
    profilesService.unfollow.mockResolvedValue(undefined);

    await expect(controller.follow(request, otherId)).resolves.toBeUndefined();
    expect(profilesService.follow).toHaveBeenCalledExactlyOnceWith(
      otherId,
      userId,
    );

    await expect(
      controller.unfollow(request, otherId),
    ).resolves.toBeUndefined();
    expect(profilesService.unfollow).toHaveBeenCalledExactlyOnceWith(
      otherId,
      userId,
    );
  });

  it('delegates findOne() to profiles.findOne', async () => {
    profilesService.findOne.mockResolvedValue(profile);

    await expect(controller.findOne(otherId)).resolves.toBe(profile);
    expect(profilesService.findOne).toHaveBeenCalledExactlyOnceWith(otherId);
  });
});
