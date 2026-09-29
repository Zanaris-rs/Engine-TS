-- AlterTable
ALTER TABLE `account` ADD COLUMN `invites_enabled` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `invite` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `created_by_account_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `claimed_by_account_id` INTEGER NULL,
    `claimed_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_reason` VARCHAR(191) NULL,

    UNIQUE INDEX `invite_code_key`(`code`),
    INDEX `invite_created_by_account_id_created_at_idx`(`created_by_account_id`, `created_at` DESC),
    INDEX `invite_claimed_by_account_id_idx`(`claimed_by_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invite_attempt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ip` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invite_attempt_ip_created_at_idx`(`ip`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
