CREATE TABLE "recipe_ratings" (
    "recipe_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "value" SMALLINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipe_ratings_pkey" PRIMARY KEY ("recipe_id", "user_id"),
    CONSTRAINT "recipe_ratings_value_check" CHECK ("value" BETWEEN 1 AND 5)
);

CREATE INDEX "recipe_ratings_user_id_idx" ON "recipe_ratings"("user_id");

ALTER TABLE "recipe_ratings" ADD CONSTRAINT "recipe_ratings_recipe_id_fkey"
    FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recipe_ratings" ADD CONSTRAINT "recipe_ratings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
