import { mock } from 'vitest-mock-extended';
import { StorageService, StorageTarget } from '../../storage/storage.service';
import { BlogImagesService } from './blog-images.service';

describe('BlogImagesService', () => {
  it('presigns a per-owner key and returns the public URL', async () => {
    const storage = mock<StorageService>();
    const upload = {
      url: 'https://s/put',
      method: 'PUT' as const,
      headers: { 'content-type': 'image/png' },
      expiresAt: new Date(),
    };
    storage.presignUpload.mockResolvedValue(upload);
    storage.publicObjectUrl.mockImplementation(
      (_target, key) => `https://s/vedora-blogs/${key}`,
    );

    const result = await new BlogImagesService(storage).createUpload('user-1', {
      contentType: 'image/png',
      sizeBytes: 100,
    });

    const [target, key, type, size] = storage.presignUpload.mock.calls[0];
    expect(target).toBe(StorageTarget.Blogs);
    expect(key).toMatch(/^blogs\/user-1\/[0-9a-f-]{36}\.png$/);
    expect([type, size]).toEqual(['image/png', 100]);
    expect(result).toEqual({
      upload,
      url: `https://s/vedora-blogs/${key}`,
    });
  });
});
