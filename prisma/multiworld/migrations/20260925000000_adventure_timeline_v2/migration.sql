-- AlterTable
ALTER TABLE `adventure_log_profile` ADD COLUMN `pinned_update_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `adventure_update` ADD COLUMN `edited_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `adventure_gz` (
    `event_id` INTEGER NOT NULL,
    `account_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `adventure_gz_account_id_created_at_idx`(`account_id`, `created_at`),
    PRIMARY KEY (`event_id`, `account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
