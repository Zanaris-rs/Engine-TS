-- CreateTable
CREATE TABLE `adventure_persona` (
    `account_id` INTEGER NOT NULL,
    `headline_colour` INTEGER NOT NULL DEFAULT 0,
    `headline_effect` INTEGER NOT NULL DEFAULT 0,
    `title` VARCHAR(191) NOT NULL DEFAULT '',
    `examine` VARCHAR(191) NOT NULL DEFAULT '',
    `hangout` VARCHAR(191) NOT NULL DEFAULT '',
    `clan` VARCHAR(191) NOT NULL DEFAULT '',
    `goals` VARCHAR(400) NOT NULL DEFAULT '[]',
    `god` VARCHAR(191) NULL,
    `home_town` VARCHAR(191) NULL,
    `playstyle` VARCHAR(191) NULL,
    `scene` VARCHAR(191) NULL,
    `signature_emote` VARCHAR(191) NULL,
    `dialogue` VARCHAR(4000) NOT NULL DEFAULT '[]',
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
