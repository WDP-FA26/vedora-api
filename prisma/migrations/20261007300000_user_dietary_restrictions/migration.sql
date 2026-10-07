CREATE TABLE "user_avoided_ingredients" (
    "user_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,

    CONSTRAINT "user_avoided_ingredients_pkey" PRIMARY KEY ("user_id","ingredient_id")
);

CREATE TABLE "user_avoided_groups" (
    "user_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,

    CONSTRAINT "user_avoided_groups_pkey" PRIMARY KEY ("user_id","group_id")
);

CREATE INDEX "user_avoided_ingredients_ingredient_id_idx" ON "user_avoided_ingredients"("ingredient_id");

CREATE INDEX "user_avoided_groups_group_id_idx" ON "user_avoided_groups"("group_id");

ALTER TABLE "user_avoided_ingredients" ADD CONSTRAINT "user_avoided_ingredients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_avoided_ingredients" ADD CONSTRAINT "user_avoided_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_avoided_groups" ADD CONSTRAINT "user_avoided_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_avoided_groups" ADD CONSTRAINT "user_avoided_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "ingredient_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

