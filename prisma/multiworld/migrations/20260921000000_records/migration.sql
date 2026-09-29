-- CreateTable
CREATE TABLE `record_attempt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `account_id` INTEGER NOT NULL,
    `profile` VARCHAR(191) NOT NULL,
    `duration_seconds` INTEGER NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'running',
    `reason` VARCHAR(191) NULL,
    `initial_logout_at` DATETIME(3) NOT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `final_logout_at` DATETIME(3) NULL,
    `stopped_at` DATETIME(3) NULL,
    `elapsed_ms` BIGINT NULL,

    INDEX `record_attempt_account_id_started_at_idx`(`account_id`, `started_at` DESC),
    INDEX `record_attempt_profile_duration_seconds_state_idx`(`profile`, `duration_seconds`, `state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `record_attempt_skill` (
    `attempt_id` INTEGER NOT NULL,
    `category` INTEGER NOT NULL,
    `start_xp` BIGINT NOT NULL,
    `end_xp` BIGINT NULL,
    `gained` BIGINT NULL,

    INDEX `record_attempt_skill_category_gained_idx`(`category`, `gained` DESC),
    PRIMARY KEY (`attempt_id`, `category`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
