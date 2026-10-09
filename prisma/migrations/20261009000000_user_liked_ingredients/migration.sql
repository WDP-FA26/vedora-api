CREATE TABLE "user_liked_ingredients" (
    "user_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,

    CONSTRAINT "user_liked_ingredients_pkey" PRIMARY KEY ("user_id","ingredient_id")
);

CREATE INDEX "user_liked_ingredients_ingredient_id_idx" ON "user_liked_ingredients"("ingredient_id");

ALTER TABLE "user_liked_ingredients" ADD CONSTRAINT "user_liked_ingredients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_liked_ingredients" ADD CONSTRAINT "user_liked_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
