import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class OcrFileContentPart {
  @IsIn(['text', 'image_url'])
  type!: 'text' | 'image_url';

  @ValidateIf((part: OcrFileContentPart) => part.type === 'text')
  @IsString()
  text?: string;
}

export class OcrFilePayload {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OcrFileContentPart)
  content!: OcrFileContentPart[];
}

export class OcrFileAnnotation {
  @IsIn(['file'])
  type!: 'file';

  @ValidateNested()
  @Type(() => OcrFilePayload)
  file!: OcrFilePayload;
}

export class OcrMessage {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OcrFileAnnotation)
  annotations?: OcrFileAnnotation[];
}

export class OcrChoice {
  @ValidateNested()
  @Type(() => OcrMessage)
  message!: OcrMessage;
}

export class OcrErrorMetadata {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OcrFileAnnotation)
  file_annotations?: OcrFileAnnotation[];
}

export class OcrError {
  @IsString()
  message!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OcrErrorMetadata)
  metadata?: OcrErrorMetadata;
}

export class OcrResponse {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OcrChoice)
  choices?: OcrChoice[];

  @IsOptional()
  @ValidateNested()
  @Type(() => OcrError)
  error?: OcrError;
}

export class OcrErrorBody {
  @IsOptional()
  @ValidateNested()
  @Type(() => OcrError)
  error?: OcrError;
}
