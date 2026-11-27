import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NoSuchKey } from '@aws-sdk/client-s3';
import type { PresignedUploadDto } from '@src/storage/presigned-upload.dto.js';
import {
  StorageTarget,
  UPLOAD_TTL_SECONDS,
} from '@src/storage/storage.service.js';

/**
 * Zero-container, in-memory drop-in for `StorageService` in e2e tests.
 * Preserves the exact public URL and key-parsing behavior of `StorageService`
 * without requiring RustFS / SeaweedFS / S3 to be running.
 */
@Injectable()
export class InMemoryStorageService {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly publicUrl: string;
  private readonly buckets: Record<StorageTarget, string>;

  constructor(config: ConfigService) {
    this.publicUrl = (
      config.get<string>('STORAGE_PUBLIC_URL') ?? 'http://localhost:9000'
    ).replace(/\/+$/, '');
    this.buckets = {
      [StorageTarget.Knowledge]:
        config.get<string>('STORAGE_KNOWLEDGE_BUCKET') ?? 'vedora-knowledge',
      [StorageTarget.Profiles]:
        config.get<string>('STORAGE_PROFILES_BUCKET') ?? 'vedora-profiles',
      [StorageTarget.Verifications]:
        config.get<string>('STORAGE_VERIFICATIONS_BUCKET') ??
        'vedora-verifications',
      [StorageTarget.Blogs]:
        config.get<string>('STORAGE_BLOGS_BUCKET') ?? 'vedora-blogs',
      [StorageTarget.Support]:
        config.get<string>('STORAGE_SUPPORT_BUCKET') ?? 'vedora-support',
    };
  }

  onModuleInit(): void {
    // No external buckets to provision in memory.
  }

  isConfigured(): boolean {
    return true;
  }

  presignUpload(
    target: StorageTarget,
    key: string,
    contentType: string,
    _size: number,
  ): Promise<PresignedUploadDto> {
    return Promise.resolve({
      url: `${this.publicObjectUrl(target, key)}?X-Amz-Signature=inmemory-upload`,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
    });
  }

  presignDownload(
    target: StorageTarget,
    key: string,
    _expiresIn: number,
  ): Promise<string> {
    return Promise.resolve(
      `${this.publicObjectUrl(target, key)}?X-Amz-Signature=inmemory-download`,
    );
  }

  exists(target: StorageTarget, key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(this.objectKey(target, key)));
  }

  publicObjectUrl(target: StorageTarget, key: string): string {
    return `${this.publicUrl}/${this.buckets[target]}/${key}`;
  }

  getBytes(target: StorageTarget, key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(this.objectKey(target, key));
    if (!bytes) {
      return Promise.reject(new NoSuchKey({ message: key, $metadata: {} }));
    }
    return Promise.resolve(new Uint8Array(bytes));
  }

  putBytes(
    target: StorageTarget,
    key: string,
    bytes: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    this.objects.set(this.objectKey(target, key), new Uint8Array(bytes));
    return Promise.resolve();
  }

  keyFromPublicUrl(target: StorageTarget, url: string): string | null {
    const prefix = `${this.publicUrl}/${this.buckets[target]}/`;
    if (!url.startsWith(prefix)) return null;
    let key: string;
    try {
      key = decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0]);
    } catch {
      return null;
    }
    return key && !key.split('/').includes('..') ? key : null;
  }

  delete(target: StorageTarget, key: string): Promise<void> {
    this.objects.delete(this.objectKey(target, key));
    return Promise.resolve();
  }

  private objectKey(target: StorageTarget, key: string): string {
    return `${this.buckets[target]}/${key}`;
  }
}
