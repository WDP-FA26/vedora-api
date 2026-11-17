import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';
import { PresignedUploadDto } from '../../../src/storage/presigned-upload.dto.js';

describe('PresignedUploadDto', () => {
  it('constructs and transforms presigned upload payload fields', () => {
    const expiresAt = new Date('2026-11-17T12:00:00.000Z');
    const dto = plainToInstance(PresignedUploadDto, {
      url: 'https://storage.vedora.vn/vedora-knowledge/doc.pdf?X-Amz-Signature=abc',
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      expiresAt,
    });

    expect(dto).toBeInstanceOf(PresignedUploadDto);
    expect(dto.method).toBe('PUT');
    expect(dto.headers).toEqual({ 'content-type': 'application/pdf' });
    expect(dto.expiresAt).toEqual(expiresAt);
  });
});
