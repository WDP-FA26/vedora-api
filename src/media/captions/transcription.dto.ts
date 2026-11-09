import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

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

export class TranscriptionWord {
  @IsString()
  word!: string;

  @IsNumber()
  start!: number;

  @IsNumber()
  end!: number;
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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TranscriptionWord)
  words?: TranscriptionWord[];
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
