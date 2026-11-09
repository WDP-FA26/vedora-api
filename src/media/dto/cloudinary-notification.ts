import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class CloudinaryVideoDetails {
  @IsOptional()
  @IsString()
  dar?: string;
}

export class CloudinaryEagerResult {
  @IsOptional()
  @IsString()
  transformation?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  error?: unknown;
}

export class CloudinaryNotification {
  @IsString()
  @IsNotEmpty()
  notification_type!: string;

  @IsOptional()
  @IsString()
  public_id?: string;

  @IsOptional()
  @IsString()
  resource_type?: string;

  @IsOptional()
  @IsNumber()
  duration?: number;

  @IsOptional()
  @IsNumber()
  width?: number;

  @IsOptional()
  @IsNumber()
  height?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => CloudinaryVideoDetails)
  video?: CloudinaryVideoDetails;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CloudinaryEagerResult)
  eager?: CloudinaryEagerResult[];
}
