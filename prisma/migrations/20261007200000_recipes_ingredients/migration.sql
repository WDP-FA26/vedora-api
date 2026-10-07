CREATE TABLE "ingredients" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "aliases" VARCHAR(100)[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ingredient_groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredient_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ingredient_group_members" (
    "group_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,

    CONSTRAINT "ingredient_group_members_pkey" PRIMARY KEY ("group_id","ingredient_id")
);

CREATE TABLE "incompatibility_rules" (
    "id" UUID NOT NULL,
    "a_ingredient_id" UUID,
    "a_group_id" UUID,
    "b_ingredient_id" UUID,
    "b_group_id" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "source" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incompatibility_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "post_id" UUID,
    "created_by_id" UUID,
    "title" VARCHAR(150) NOT NULL,
    "description" VARCHAR(1000),
    "servings" INTEGER NOT NULL,
    "prep_minutes" INTEGER,
    "cook_minutes" INTEGER,
    "steps" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recipe_ingredients" (
    "recipe_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "quantity" DECIMAL(8,2),
    "unit" VARCHAR(30),
    "note" VARCHAR(200),

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("recipe_id","ingredient_id")
);

CREATE UNIQUE INDEX "ingredients_name_key" ON "ingredients"("name");

CREATE UNIQUE INDEX "ingredient_groups_name_key" ON "ingredient_groups"("name");

CREATE INDEX "ingredient_group_members_ingredient_id_idx" ON "ingredient_group_members"("ingredient_id");

CREATE INDEX "incompatibility_rules_a_ingredient_id_idx" ON "incompatibility_rules"("a_ingredient_id");

CREATE INDEX "incompatibility_rules_a_group_id_idx" ON "incompatibility_rules"("a_group_id");

CREATE INDEX "incompatibility_rules_b_ingredient_id_idx" ON "incompatibility_rules"("b_ingredient_id");

CREATE INDEX "incompatibility_rules_b_group_id_idx" ON "incompatibility_rules"("b_group_id");

CREATE INDEX "recipes_post_id_idx" ON "recipes"("post_id");

CREATE INDEX "recipe_ingredients_ingredient_id_idx" ON "recipe_ingredients"("ingredient_id");

ALTER TABLE "ingredient_group_members" ADD CONSTRAINT "ingredient_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "ingredient_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ingredient_group_members" ADD CONSTRAINT "ingredient_group_members_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incompatibility_rules" ADD CONSTRAINT "incompatibility_rules_a_ingredient_id_fkey" FOREIGN KEY ("a_ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incompatibility_rules" ADD CONSTRAINT "incompatibility_rules_a_group_id_fkey" FOREIGN KEY ("a_group_id") REFERENCES "ingredient_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incompatibility_rules" ADD CONSTRAINT "incompatibility_rules_b_ingredient_id_fkey" FOREIGN KEY ("b_ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incompatibility_rules" ADD CONSTRAINT "incompatibility_rules_b_group_id_fkey" FOREIGN KEY ("b_group_id") REFERENCES "ingredient_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recipes" ADD CONSTRAINT "recipes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recipes" ADD CONSTRAINT "recipes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "incompatibility_rules" ADD CONSTRAINT "incompatibility_rules_a_side_check" CHECK (num_nonnulls("a_ingredient_id", "a_group_id") = 1);
ALTER TABLE "incompatibility_rules" ADD CONSTRAINT "incompatibility_rules_b_side_check" CHECK (num_nonnulls("b_ingredient_id", "b_group_id") = 1);
