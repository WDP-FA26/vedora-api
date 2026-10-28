import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

// The bodies OpenRouter answers with, as class-validator DTOs: parsed with
// `validatePayload`, which strips the fields we do not read.

export class OpenRouterError {
  @IsString()
  message!: string;
}

export class OpenRouterErrorBody {
  @IsOptional()
  @ValidateNested()
  @Type(() => OpenRouterError)
  error?: OpenRouterError;
}

export class EmbeddingItem {
  @IsOptional()
  @IsInt()
  index?: number;

  @IsArray()
  @IsNumber({}, { each: true })
  embedding!: number[];
}

export class EmbeddingsResponse {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmbeddingItem)
  data!: EmbeddingItem[];
}

export class RerankItem {
  @IsInt()
  index!: number;

  @IsNumber()
  relevance_score!: number;
}

export class RerankResponse {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RerankItem)
  results!: RerankItem[];
}

/** One part of a parsed PDF page: its Markdown, or an embedded image. */
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

/** A carrier completion: the parse rides on its annotations, even on errors. */
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
