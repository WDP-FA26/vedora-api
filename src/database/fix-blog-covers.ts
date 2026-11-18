/**
 * One-off repair: set every blog's cover to the first image in its content,
 * the rule BlogsService now applies on each save. Older blogs can carry a
 * cover the author has since removed from the article.
 *
 *   npm run fix:blog-covers            # dry run: lists what would change
 *   npm run fix:blog-covers -- --apply # writes the changes
 *
 * Like BlogsService, only images in Vedora's blog storage count; a blog whose
 * images are all external gets no cover. Only `blog.coverImageUrl` is
 * written; status, moderation and `updatedAt` are left alone, so no blog goes
 * back to review.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { coverFromContent } from '../posts/blogs/blog-cover.js';

interface BlogRow {
  _id: string;
  blog: { title: string; content: string; coverImageUrl: string | null };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // Same default as src/config/environment.ts.
  const bucket = process.env.STORAGE_BLOGS_BUCKET || 'vedora-blogs';
  const storagePrefix = `${required('STORAGE_PUBLIC_URL').replace(/\/+$/, '')}/${bucket}/`;
  // Mirrors StorageService.keyFromPublicUrl, the only covers BlogsService
  // accepts: images uploaded to Vedora's blog bucket.
  const isAllowed = (url: string) => {
    if (!url.startsWith(storagePrefix)) return false;
    try {
      const key = decodeURIComponent(
        url.slice(storagePrefix.length).split(/[?#]/)[0],
      );
      return key !== '' && !key.split('/').includes('..');
    } catch {
      return false;
    }
  };

  const connection = await mongoose
    .createConnection(required('DATABASE_URL'))
    .asPromise();
  try {
    const posts = connection.collection<BlogRow>('posts');
    const rows = await posts
      .find(
        { type: 'BLOG' },
        {
          projection: {
            'blog.title': 1,
            'blog.content': 1,
            'blog.coverImageUrl': 1,
          },
        },
      )
      .toArray();

    let changed = 0;
    for (const row of rows) {
      const cover = coverFromContent(row.blog.content ?? '', isAllowed);
      if (cover === (row.blog.coverImageUrl ?? null)) continue;
      changed++;
      console.log(
        `${row._id}  ${row.blog.title}\n  from ${row.blog.coverImageUrl ?? '(none)'}\n  to   ${cover ?? '(none)'}`,
      );
      if (apply) {
        await posts.updateOne(
          { _id: row._id },
          { $set: { 'blog.coverImageUrl': cover } },
        );
      }
    }
    console.log(
      `${rows.length} blogs checked, ${changed} ${apply ? 'updated' : 'would change (dry run; pass --apply to write)'}.`,
    );
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  console.error('Fixing blog covers failed.', error);
  process.exitCode = 1;
});
