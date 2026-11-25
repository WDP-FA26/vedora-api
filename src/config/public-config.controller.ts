import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { DisabledEndpointGuard } from '../common/guards/disabled-endpoint.guard.js';
import { runtimeConfig } from './runtime-config.js';

/** Deliberate allowlist. Never serialize ConfigService or process.env. */
export function publicRuntimeConfig() {
  const config = {
    timeZone: runtimeConfig.APP_TIMEZONE,
    auth: {
      usernameMinLength: runtimeConfig.AUTH_USERNAME_MIN_LENGTH,
      usernameMaxLength: runtimeConfig.AUTH_USERNAME_MAX_LENGTH,
      fullNameMaxLength: runtimeConfig.AUTH_FULL_NAME_MAX_LENGTH,
      passwordMinLength: runtimeConfig.AUTH_PASSWORD_MIN_LENGTH,
      otpLength: runtimeConfig.AUTH_OTP_LENGTH,
    },
    content: {
      postMaxWords: runtimeConfig.POST_MAX_WORDS,
      postMaxLength: runtimeConfig.POST_MAX_LENGTH,
      postMaxMedia: runtimeConfig.POST_MAX_MEDIA,
      commentMaxLength: runtimeConfig.COMMENT_MAX_LENGTH,
      messageMaxLength: runtimeConfig.MESSAGE_MAX_LENGTH,
      reportMaxDetailsLength: runtimeConfig.REPORT_MAX_DETAILS_LENGTH,
      blogTitleMaxLength: runtimeConfig.BLOG_TITLE_MAX_LENGTH,
      blogContentMaxLength: runtimeConfig.BLOG_CONTENT_MAX_LENGTH,
      blogMaxRecipes: runtimeConfig.BLOG_MAX_RECIPES,
      profileBioMaxLength: runtimeConfig.PROFILE_BIO_MAX_LENGTH,
      recipeTitleMaxLength: runtimeConfig.RECIPE_TITLE_MAX_LENGTH,
      recipeMaxIngredients: runtimeConfig.RECIPE_MAX_INGREDIENTS,
      recipeMaxSteps: runtimeConfig.RECIPE_MAX_STEPS,
      recipeStepMaxLength: runtimeConfig.RECIPE_STEP_MAX_LENGTH,
      mealPlanMaxDishesPerSection:
        runtimeConfig.MEAL_PLAN_MAX_DISHES_PER_SECTION,
      searchQueryMaxLength: runtimeConfig.SEARCH_QUERY_MAX_LENGTH,
    },
    uploads: {
      reportMaxEvidenceImages: runtimeConfig.REPORT_MAX_EVIDENCE_IMAGES,
      reportEvidenceMaxMb: runtimeConfig.REPORT_EVIDENCE_MAX_MB,
      profileAvatarMaxMb: runtimeConfig.PROFILE_AVATAR_MAX_MB,
      profileCoverMaxMb: runtimeConfig.PROFILE_COVER_MAX_MB,
      blogImageMaxMb: runtimeConfig.BLOG_IMAGE_MAX_MB,
      verificationMaxProofs: runtimeConfig.VERIFICATION_MAX_PROOFS,
      verificationProofMaxMb: runtimeConfig.VERIFICATION_PROOF_MAX_MB,
    },
    ai: {
      nutritionMaxMessages: runtimeConfig.NUTRITION_CHAT_MAX_MESSAGES,
      nutritionMaxMessageLength:
        runtimeConfig.NUTRITION_CHAT_MAX_MESSAGE_LENGTH,
      plannerMaxMessages: runtimeConfig.PLANNER_CHAT_MAX_MESSAGES,
      plannerMaxMessageLength: runtimeConfig.PLANNER_CHAT_MAX_MESSAGE_LENGTH,
      blogMaxMessages: runtimeConfig.BLOG_AI_MAX_MESSAGES,
      blogMaxSelectionLength: runtimeConfig.BLOG_AI_MAX_SELECTION_LENGTH,
      imageDefaultAspectRatio: runtimeConfig.AI_IMAGE_DEFAULT_ASPECT_RATIO,
      imageAspectRatios: runtimeConfig.AI_IMAGE_ALLOWED_ASPECT_RATIOS.split(
        ',',
      ).map((value) => value.trim()),
    },
    pagination: {
      defaultLimit: runtimeConfig.PAGINATION_DEFAULT_LIMIT,
      maxLimit: runtimeConfig.PAGINATION_MAX_LIMIT,
      adminDefaultLimit: runtimeConfig.ADMIN_PAGINATION_DEFAULT_LIMIT,
      adminMaxLimit: runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT,
      reportMaxDays: runtimeConfig.ADMIN_REPORT_MAX_DAYS,
    },
    payment: {
      ttlSeconds: runtimeConfig.PAYMENT_INTENT_TTL_SECONDS,
      codeSuffixLength: runtimeConfig.PAYMENT_CODE_SUFFIX_LENGTH,
    },
  };
  const version = createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex')
    .slice(0, 16);
  return { version, ...config };
}

@ApiExcludeController()
@ApiTags('config')
@UseGuards(DisabledEndpointGuard)
@Controller('public-config')
export class PublicConfigController {
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Public UI limits from backend startup configuration; excludes credentials and prompts',
  })
  get() {
    return publicRuntimeConfig();
  }
}
