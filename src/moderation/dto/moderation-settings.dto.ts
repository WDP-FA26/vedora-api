import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
  Validate,
  ValidateNested,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { ALLOW_KEY } from '../policies/content.js';

const MAX_CHOICES = 16;
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

@ValidatorConstraint({ name: 'belowRejectThreshold' })
class BelowRejectThreshold implements ValidatorConstraintInterface {
  validate(value: unknown, { object }: ValidationArguments): boolean {
    return (
      typeof value === 'number' &&
      'rejectThreshold' in object &&
      typeof object.rejectThreshold === 'number' &&
      value < object.rejectThreshold
    );
  }

  defaultMessage(): string {
    return 'reviewThreshold must be lower than rejectThreshold';
  }
}

export class ModerationChoiceDto {
  @ApiProperty({
    example: 'hate',
    description:
      'Stable id, 2-32 characters: lowercase letters, digits and _, starting with a letter. Stored on posts, so do not reuse one for something else. `allow` is built in',
  })
  @IsString()
  @Matches(KEY_PATTERN, {
    message:
      'key must be 2-32 characters: lowercase letters, digits and _, starting with a letter',
  })
  @NotEquals(ALLOW_KEY, {
    message: '"allow" is built in and cannot be a category',
  })
  key!: string;

  @ApiProperty({ example: 'Thù ghét', description: 'Name admins see' })
  @Trim()
  @IsString()
  @Length(1, 40)
  label!: string;

  @ApiProperty({
    example: 'ngôn từ thù ghét',
    description: 'Shown to the author after "vi phạm tiêu chuẩn cộng đồng: "',
  })
  @Trim()
  @IsString()
  @Length(3, 120)
  reasonText!: string;

  @ApiProperty({
    description:
      'What counts as this category: the criterion the model is given',
  })
  @Trim()
  @IsString()
  @Length(10, 800)
  description!: string;
}

export class ModerationPolicyDto {
  @ApiProperty({
    description: 'General instructions for the model',
  })
  @Trim()
  @IsString()
  @Length(20, 3000)
  instructions!: string;

  @ApiProperty({ description: 'The criterion for `allow`' })
  @Trim()
  @IsString()
  @Length(10, 800)
  allowDescription!: string;

  @ApiProperty({
    type: [ModerationChoiceDto],
    description: 'The categories, in the order admins see them',
  })
  @ValidateNested({ each: true })
  @Type(() => ModerationChoiceDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CHOICES)
  @ArrayUnique((choice: ModerationChoiceDto) => choice.key, {
    message: 'choice keys must be unique',
  })
  choices!: ModerationChoiceDto[];

  @ApiProperty({
    minimum: 0,
    maximum: 1,
    description: 'A violation chance at or above this is rejected outright',
  })
  @IsNumber()
  @Min(0)
  @Max(1)
  rejectThreshold!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 1,
    description:
      'A violation chance at or above this, below the reject threshold, waits for an admin',
  })
  @IsNumber()
  @Min(0)
  @Max(1)
  @Validate(BelowRejectThreshold)
  reviewThreshold!: number;
}

export class UpdateModerationSettingsDto extends ModerationPolicyDto {
  @ApiProperty({
    minimum: 0,
    description:
      'The `version` you loaded. A different current version answers 409, so two admins cannot overwrite each other',
  })
  @IsInt()
  @Min(0)
  version!: number;
}

export class ModerationSettingsDto extends ModerationPolicyDto {
  @ApiProperty({
    minimum: 0,
    description: '0 while the built-in defaults are in force',
  })
  version!: number;

  @ApiProperty({ nullable: true, type: Date }) updatedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) updatedById!: string | null;
  @ApiProperty() isDefault!: boolean;
}

export class TestModerationDto {
  @ApiProperty({ maxLength: 5000 })
  @IsString()
  @MaxLength(5000)
  text!: string;

  @ApiPropertyOptional({
    type: ModerationPolicyDto,
    description:
      'A draft policy to try without saving it. Omit it to use the saved one',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ModerationPolicyDto)
  settings?: ModerationPolicyDto;
}

export class ModerationTestResultDto {
  @ApiProperty({ enum: ['publish', 'review', 'reject'] })
  decision!: 'publish' | 'review' | 'reject';

  @ApiProperty({ nullable: true, type: String })
  category!: string | null;

  @ApiProperty({ minimum: 0, maximum: 1 })
  violationScore!: number;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'number' },
    description: "The model's chance for every choice, `allow` included",
  })
  scores!: Record<string, number> | null;
}
