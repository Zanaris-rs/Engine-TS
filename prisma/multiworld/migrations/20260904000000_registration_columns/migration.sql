-- AlterTable
ALTER TABLE `account` ADD COLUMN `email` VARCHAR(191) NOT NULL,
    ADD COLUMN `email_normalized` VARCHAR(191) NOT NULL,
    ADD COLUMN `playable_after` DATETIME(3) NULL,
    ADD COLUMN `registration_group` VARCHAR(191) NULL,
    ADD COLUMN `signup_agent_hash` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `signup_attempt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ip` VARCHAR(191) NOT NULL,
    `ip_group` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `signup_attempt_ip_created_at_idx`(`ip`, `created_at`),
    INDEX `signup_attempt_ip_group_created_at_idx`(`ip_group`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `account_email_normalized_idx` ON `account`(`email_normalized`);

-- CreateIndex
CREATE INDEX `account_registration_ip_idx` ON `account`(`registration_ip`);

-- CreateIndex
CREATE INDEX `account_registration_group_idx` ON `account`(`registration_group`);

