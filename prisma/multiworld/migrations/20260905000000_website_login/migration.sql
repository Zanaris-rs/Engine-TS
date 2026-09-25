-- CreateTable
CREATE TABLE `login_attempt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(191) NOT NULL,
    `ip` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_attempt_username_created_at_idx`(`username`, `created_at`),
    INDEX `login_attempt_ip_created_at_idx`(`ip`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `session_profile_account_id_timestamp_idx` ON `session`(`profile`, `account_id`, `timestamp` DESC);
