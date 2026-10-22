CREATE TABLE "recipe_favorites" (
    "recipe_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recipe_favorites_pkey" PRIMARY KEY ("recipe_id", "user_id")
);
CREATE INDEX "recipe_favorites_user_id_created_at_recipe_id_idx"
    ON "recipe_favorites"("user_id", "created_at", "recipe_id");
ALTER TABLE "recipe_favorites" ADD CONSTRAINT "recipe_favorites_recipe_id_fkey"
    FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recipe_favorites" ADD CONSTRAINT "recipe_favorites_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
