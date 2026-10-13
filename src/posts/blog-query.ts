import { Prisma } from '@prisma/client';
import { BlogSummaryDto } from './dto/blog-summary.dto';

// Feed reads never load the full article.
export const blogSummarySelect = {
  title: true,
  coverImageUrl: true,
  excerpt: true,
  recipes: {
    orderBy: { position: 'asc' },
    select: { recipe: { select: { id: true, title: true, imageUrl: true } } },
  },
} satisfies Prisma.BlogSelect;

export function toBlogSummary(
  blog: Prisma.BlogGetPayload<{ select: typeof blogSummarySelect }> | null,
): BlogSummaryDto | null {
  return blog
    ? {
        title: blog.title,
        coverImageUrl: blog.coverImageUrl,
        excerpt: blog.excerpt,
        recipes: blog.recipes.map(({ recipe }) => recipe),
      }
    : null;
}
