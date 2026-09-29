-- CreateTable
CREATE TABLE `adventure_log_profile` (
    `account_id` INTEGER NOT NULL,
    `headline` VARCHAR(191) NOT NULL DEFAULT '',
    `about` TEXT NOT NULL,
    `custom_css` TEXT NOT NULL,
    `css_disabled_at` DATETIME(3) NULL,
    `hidden_categories` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adventure_update` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `account_id` INTEGER NOT NULL,
    `body` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,
    `staff_hidden_at` DATETIME(3) NULL,

    INDEX `adventure_update_account_id_created_at_idx`(`account_id`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adventure_reply` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `update_id` INTEGER NOT NULL,
    `author_account_id` INTEGER NOT NULL,
    `body` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,
    `staff_hidden_at` DATETIME(3) NULL,

    INDEX `adventure_reply_update_id_created_at_idx`(`update_id`, `created_at`),
    INDEX `adventure_reply_author_account_id_created_at_idx`(`author_account_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adventure_block` (
    `owner_account_id` INTEGER NOT NULL,
    `blocked_account_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`owner_account_id`, `blocked_account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adventure_report` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reporter_account_id` INTEGER NOT NULL,
    `target_kind` VARCHAR(191) NOT NULL,
    `target_id` INTEGER NOT NULL,
    `reason` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at` DATETIME(3) NULL,
    `resolved_by_account_id` INTEGER NULL,
    `resolution` VARCHAR(191) NULL,
    `note` TEXT NULL,

    INDEX `adventure_report_reporter_account_id_created_at_idx`(`reporter_account_id`, `created_at`),
    INDEX `adventure_report_resolved_at_created_at_idx`(`resolved_at`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
