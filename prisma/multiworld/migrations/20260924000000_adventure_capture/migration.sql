-- CreateTable
CREATE TABLE `adventure_event` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `account_id` INTEGER NOT NULL,
    `profile` VARCHAR(191) NOT NULL,
    `session_uuid` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `category` INTEGER NOT NULL,
    `event` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `adventure_event_session_uuid_seq_key`(`session_uuid`, `seq`),
    INDEX `adventure_event_account_id_profile_occurred_at_idx`(`account_id`, `profile`, `occurred_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `account_look` (
    `account_id` INTEGER NOT NULL,
    `profile` VARCHAR(191) NOT NULL,
    `gender` INTEGER NOT NULL,
    `kits` VARCHAR(191) NOT NULL,
    `colours` VARCHAR(191) NOT NULL,
    `worn` VARCHAR(191) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`account_id`, `profile`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
