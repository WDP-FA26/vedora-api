import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ContentModerationService } from './content-moderation.service.js';
import {
  type ContentSettings,
  ModerationSettingsService,
} from './moderation-settings.service.js';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { UserRole } from '../mongo/models.js';
import {
  ModerationSettingsDto,
  ModerationTestResultDto,
  TestModerationDto,
  UpdateModerationSettingsDto,
} from './dto/moderation-settings.dto.js';

function toDto(settings: ContentSettings): ModerationSettingsDto {
  return { ...settings, isDefault: settings.version === 0 };
}

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiForbiddenResponse({
  type: ErrorBodyDto,
  description: 'Insufficient account permissions',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/moderation/settings')
export class AdminModerationController {
  constructor(
    private readonly settings: ModerationSettingsService,
    private readonly moderation: ContentModerationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The content policy: categories, instructions and thresholds',
    description:
      'Applies to new posts, blogs, comments and videos right away (within about 15 seconds). Content already judged keeps its result.',
  })
  @ApiOkResponse({ type: ModerationSettingsDto })
  async find(): Promise<ModerationSettingsDto> {
    return toDto(await this.settings.get());
  }

  @Put()
  @ApiOperation({ summary: 'Replace the content policy' })
  @ApiOkResponse({ type: ModerationSettingsDto })
  @ApiBadRequestResponse({
    type: ErrorBodyDto,
    description: '`VALIDATION_FAILED`: `details.messages` lists what to fix',
  })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'Someone saved a newer version first',
  })
  async update(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdateModerationSettingsDto,
  ): Promise<ModerationSettingsDto> {
    const { version, ...policy } = dto;
    return toDto(await this.settings.save(policy, request.user.sub, version));
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Go back to the built-in content policy' })
  @ApiOkResponse({ type: ModerationSettingsDto })
  async reset(): Promise<ModerationSettingsDto> {
    return toDto(await this.settings.reset());
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Try a text against the saved policy or a draft, without saving',
    description:
      'Calls the moderation model, so it is slow and costs a little. Nothing is stored.',
  })
  @ApiOkResponse({ type: ModerationTestResultDto })
  async test(@Body() dto: TestModerationDto): Promise<ModerationTestResultDto> {
    try {
      return await this.moderation.review(
        [{ kind: 'text', text: dto.text }],
        undefined,
        dto.settings,
      );
    } catch {
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'The moderation model did not answer, try again',
      );
    }
  }
}
