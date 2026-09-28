-- AlterTable
ALTER TABLE `adventure_log_profile` DROP COLUMN `headline`,
    ADD COLUMN `hidden_parts` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `adventure_persona` DROP COLUMN `headline_colour`,
    DROP COLUMN `headline_effect`;
