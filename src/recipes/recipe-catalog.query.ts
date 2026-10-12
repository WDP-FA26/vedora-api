import { Prisma } from '@prisma/client';
import type { RecipeCatalogQueryDto } from './dto/recipe-catalog.dto';

/** Parameterized PostgreSQL predicates: all filters run before paging/counting. */
export function catalogWhere(
  query: RecipeCatalogQueryDto,
  userId?: string,
): Prisma.Sql {
  const filters: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.q !== undefined) {
    // strpos treats %, _ and backslashes as text, not LIKE wildcards.
    filters.push(Prisma.sql`(
      strpos(lower(r.title), lower(${query.q})) > 0
      OR strpos(lower(COALESCE(r.description, '')), lower(${query.q})) > 0
      OR EXISTS (
        SELECT 1 FROM recipe_ingredients ri
        JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id = r.id AND (
          strpos(lower(i.name), lower(${query.q})) > 0
          OR EXISTS (
            SELECT 1 FROM unnest(i.aliases) AS alias(name)
            WHERE strpos(lower(alias.name), lower(${query.q})) > 0
          )
        )
      )
    )`);
  }
  if (query.maxMinutes !== undefined) {
    filters.push(Prisma.sql`(
      (r.prep_minutes IS NOT NULL OR r.cook_minutes IS NOT NULL)
      AND COALESCE(r.prep_minutes, 0) + COALESCE(r.cook_minutes, 0) <= ${query.maxMinutes}
    )`);
  }
  if (query.suitableForMe) {
    filters.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM recipe_ingredients ri
      WHERE ri.recipe_id = r.id AND (
        EXISTS (
          SELECT 1 FROM user_avoided_ingredients avoided
          WHERE avoided.user_id = ${userId}::uuid
            AND avoided.ingredient_id = ri.ingredient_id
        )
        OR EXISTS (
          SELECT 1 FROM ingredient_group_members member
          JOIN user_avoided_groups avoided ON avoided.group_id = member.group_id
          WHERE avoided.user_id = ${userId}::uuid
            AND member.ingredient_id = ri.ingredient_id
        )
      )
    )`);
    // Each side can name an ingredient or a group. The two ingredients must
    // differ, including when a group overlaps itself or another group.
    filters.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM incompatibility_rules rule
      JOIN recipe_ingredients a ON a.recipe_id = r.id
      JOIN recipe_ingredients b ON b.recipe_id = r.id
        AND b.ingredient_id <> a.ingredient_id
      WHERE (
        a.ingredient_id = rule.a_ingredient_id
        OR EXISTS (
          SELECT 1 FROM ingredient_group_members member
          WHERE member.ingredient_id = a.ingredient_id
            AND member.group_id = rule.a_group_id
        )
      ) AND (
        b.ingredient_id = rule.b_ingredient_id
        OR EXISTS (
          SELECT 1 FROM ingredient_group_members member
          WHERE member.ingredient_id = b.ingredient_id
            AND member.group_id = rule.b_group_id
        )
      )
    )`);
  }
  return Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`;
}
