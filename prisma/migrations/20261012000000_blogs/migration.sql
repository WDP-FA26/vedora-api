ALTER TYPE "PostStatus" ADD VALUE 'DRAFT';

CREATE TABLE "blogs" (
    "post_id" UUID NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "cover_image_url" VARCHAR(2048),
    "content" TEXT NOT NULL,
    "excerpt" VARCHAR(280) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "blogs_pkey" PRIMARY KEY ("post_id")
);

CREATE TABLE "blog_recipes" (
    "post_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "blog_recipes_pkey" PRIMARY KEY ("post_id", "recipe_id")
);

CREATE INDEX "blog_recipes_recipe_id_idx" ON "blog_recipes"("recipe_id");
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_post_id_fkey"
    FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_recipes" ADD CONSTRAINT "blog_recipes_post_id_fkey"
    FOREIGN KEY ("post_id") REFERENCES "blogs"("post_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_recipes" ADD CONSTRAINT "blog_recipes_recipe_id_fkey"
    FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
