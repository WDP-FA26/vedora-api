import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// Whisper's verbose JSON, as class-validator DTOs: parsed with
// `parsePayload`, which strips the fields we do not read.

export class WhisperSegment {
  @IsNumber()
  start!: number;

  @IsNumber()
  end!: number;

  @IsString()
  text!: string;

  @IsOptional()
  @IsNumber()
  avg_logprob?: number;

  @IsOptional()
  @IsNumber()
  no_speech_prob?: number;
}

export class TranscriptionResponse {
  @IsString()
  text!: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhisperSegment)
  segments?: WhisperSegment[];
}

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
