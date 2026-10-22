import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { StorageService, StorageTarget } from '../storage/storage.service';
import {
  BlogImageUploadDto,
  CreateBlogImageUploadDto,
} from './dto/blog-image.dto';

const EXTENSIONS: Record<CreateBlogImageUploadDto['contentType'], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Images for blog bodies. They're only referenced by URL from the Markdown,
 * so nothing is recorded per upload.
 */
@Injectable()
export class BlogImagesService {
  constructor(private readonly storage: StorageService) {}

  async createUpload(
    ownerId: string,
    dto: CreateBlogImageUploadDto,
  ): Promise<BlogImageUploadDto> {
    const key = `blogs/${ownerId}/${randomUUID()}.${EXTENSIONS[dto.contentType]}`;
    const upload = await this.storage.presignUpload(
      StorageTarget.Blogs,
      key,
      dto.contentType,
      dto.sizeBytes,
    );
    return {
      upload,
      url: this.storage.publicObjectUrl(StorageTarget.Blogs, key),
    };
  }
}
