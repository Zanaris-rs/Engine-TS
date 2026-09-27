-- AlterTable
ALTER TABLE `adventure_persona` DROP COLUMN `clan`,
    DROP COLUMN `playstyle`,
    ADD COLUMN `facing` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `adventure_clan` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `motto` VARCHAR(191) NOT NULL DEFAULT '',
    `crest` INTEGER NOT NULL,
    `world` INTEGER NULL,
    `about` VARCHAR(600) NOT NULL DEFAULT '',
    `perm_invite` INTEGER NOT NULL DEFAULT 4,
    `perm_remove` INTEGER NOT NULL DEFAULT 1,
    `perm_ranks` INTEGER NOT NULL DEFAULT 1,
    `perm_page` INTEGER NOT NULL DEFAULT 2,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `adventure_clan_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adventure_clan_member` (
    `account_id` INTEGER NOT NULL,
    `clan_id` INTEGER NOT NULL,
    `rank` VARCHAR(191) NOT NULL,
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `adventure_clan_member_clan_id_idx`(`clan_id`),
    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adventure_clan_invite` (
    `clan_id` INTEGER NOT NULL,
    `account_id` INTEGER NOT NULL,
    `invited_by_account_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `adventure_clan_invite_account_id_idx`(`account_id`),
    PRIMARY KEY (`clan_id`, `account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adventure_clan_notice` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `clan_id` INTEGER NOT NULL,
    `author_account_id` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` VARCHAR(280) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `adventure_clan_notice_clan_id_created_at_idx`(`clan_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
