-- CreateTable
CREATE TABLE `adventure_outfit` (
    `account_id` INTEGER NOT NULL,
    `slot` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `gender` INTEGER NOT NULL,
    `kits` VARCHAR(191) NOT NULL,
    `colours` VARCHAR(191) NOT NULL,
    `worn` VARCHAR(191) NOT NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`account_id`, `slot`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
