-- CreateEnum
CREATE TYPE "DietMode" AS ENUM ('VEGETARIAN', 'VEGAN');

-- CreateEnum
CREATE TYPE "AllergyAcknowledgement" AS ENUM ('UNCONFIRMED', 'NONE_DECLARED', 'DECLARED');

-- CreateEnum
CREATE TYPE "ExclusionReason" AS ENUM ('DIET', 'ALLERGY', 'PERSONAL');

-- CreateEnum
CREATE TYPE "VegetarianStatus" AS ENUM ('ALLOWED', 'FORBIDDEN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VeganStatus" AS ENUM ('VEGAN', 'NON_VEGAN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AnimalLabel" AS ENUM ('MEAT', 'FISH', 'SEAFOOD', 'SLAUGHTER_DERIVED', 'DAIRY', 'EGG', 'HONEY');

-- CreateEnum
CREATE TYPE "AllergenLabel" AS ENUM ('MILK', 'EGG', 'SOY', 'PEANUT', 'TREE_NUT', 'WHEAT', 'SESAME', 'FISH', 'SHELLFISH', 'OTHER');

-- CreateEnum
CREATE TYPE "DietaryLabelKind" AS ENUM ('ANIMAL', 'ALLERGEN');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "allergy_acknowledgement" "AllergyAcknowledgement" NOT NULL DEFAULT 'UNCONFIRMED',
ADD COLUMN     "diet_mode" "DietMode" NOT NULL DEFAULT 'VEGETARIAN',
ADD COLUMN     "dietary_updated_at" TIMESTAMP(3),
ADD COLUMN     "dietary_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ingredients" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allergen_labels" "AllergenLabel"[] DEFAULT ARRAY[]::"AllergenLabel"[],
ADD COLUMN     "allergens_complete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "animal_labels" "AnimalLabel"[] DEFAULT ARRAY[]::"AnimalLabel"[],
ADD COLUMN     "classification_reason" VARCHAR(500),
ADD COLUMN     "classification_source" VARCHAR(500),
ADD COLUMN     "composition_complete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "may_contain_allergens" "AllergenLabel"[] DEFAULT ARRAY[]::"AllergenLabel"[],
ADD COLUMN     "safety_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "vegan_status" "VeganStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "vegetarian_status" "VegetarianStatus" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "user_avoided_ingredients" DROP CONSTRAINT "user_avoided_ingredients_pkey",
ADD COLUMN     "reason" "ExclusionReason" NOT NULL DEFAULT 'PERSONAL',
ADD CONSTRAINT "user_avoided_ingredients_pkey" PRIMARY KEY ("user_id", "ingredient_id", "reason");

-- AlterTable
ALTER TABLE "user_avoided_groups" DROP CONSTRAINT "user_avoided_groups_pkey",
ADD COLUMN     "reason" "ExclusionReason" NOT NULL DEFAULT 'PERSONAL',
ADD CONSTRAINT "user_avoided_groups_pkey" PRIMARY KEY ("user_id", "group_id", "reason");

-- CreateTable
CREATE TABLE "user_avoided_labels" (
    "user_id" UUID NOT NULL,
    "kind" "DietaryLabelKind" NOT NULL,
    "label" VARCHAR(30) NOT NULL,
    "reason" "ExclusionReason" NOT NULL,

    CONSTRAINT "user_avoided_labels_pkey" PRIMARY KEY ("user_id","kind","label","reason")
);

-- AddForeignKey
ALTER TABLE "user_avoided_labels" ADD CONSTRAINT "user_avoided_labels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Legacy restrictions keep PERSONAL; no allergy confirmation or safety claim is inferred.
ALTER TABLE "user_avoided_ingredients" DROP CONSTRAINT "user_avoided_ingredients_ingredient_id_fkey";
ALTER TABLE "user_avoided_ingredients" ADD CONSTRAINT "user_avoided_ingredients_ingredient_id_fkey" FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_avoided_groups" DROP CONSTRAINT "user_avoided_groups_group_id_fkey";
ALTER TABLE "user_avoided_groups" ADD CONSTRAINT "user_avoided_groups_group_id_fkey" FOREIGN KEY (group_id) REFERENCES ingredient_groups(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ingredients"
  ALTER COLUMN "animal_labels" SET NOT NULL,
  ALTER COLUMN "allergen_labels" SET NOT NULL,
  ALTER COLUMN "may_contain_allergens" SET NOT NULL,
  ADD CONSTRAINT "ingredients_safety_version_positive" CHECK (safety_version > 0),
  ADD CONSTRAINT "ingredients_allergen_composition" CHECK (NOT allergens_complete OR composition_complete),
  ADD CONSTRAINT "ingredients_vegan_consistency" CHECK (vegan_status <> 'VEGAN' OR (vegetarian_status = 'ALLOWED' AND cardinality(animal_labels) = 0)),
  ADD CONSTRAINT "ingredients_vegetarian_consistency" CHECK (vegetarian_status <> 'ALLOWED' OR NOT animal_labels && ARRAY['MEAT','FISH','SEAFOOD','SLAUGHTER_DERIVED']::"AnimalLabel"[]);
ALTER TABLE "users" ADD CONSTRAINT "users_dietary_version_nonnegative" CHECK (dietary_version >= 0);
ALTER TABLE "user_avoided_labels" ADD CONSTRAINT "avoided_label_supported" CHECK (
  (kind = 'ANIMAL' AND label IN ('MEAT','FISH','SEAFOOD','SLAUGHTER_DERIVED','DAIRY','EGG','HONEY') AND reason <> 'ALLERGY') OR
  (kind = 'ALLERGEN' AND label IN ('MILK','EGG','SOY','PEANUT','TREE_NUT','WHEAT','SESAME','FISH','SHELLFISH','OTHER'))
);
