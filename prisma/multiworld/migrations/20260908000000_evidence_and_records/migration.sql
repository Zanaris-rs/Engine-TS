-- AlterTable
ALTER TABLE `report` ADD COLUMN `offender_account_id` INTEGER NULL,
    ADD COLUMN `offender_coord` INTEGER NULL,
    ADD COLUMN `offender_session_uuid` VARCHAR(191) NULL,
    ADD COLUMN `resolution` VARCHAR(191) NULL,
    ADD COLUMN `resolved_at` DATETIME(3) NULL,
    ADD COLUMN `resolved_by_account_id` INTEGER NULL,
    ADD COLUMN `staff_note` TEXT NULL,
    ADD COLUMN `uuid` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `report_input` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `report_uuid` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `client` VARCHAR(191) NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `flushed_at` DATETIME(3) NOT NULL,
    `data` LONGBLOB NOT NULL,

    INDEX `report_input_report_uuid_seq_idx`(`report_uuid`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `report_chat` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `report_uuid` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `to_username` VARCHAR(191) NULL,
    `coord` INTEGER NOT NULL,
    `message` VARCHAR(191) NOT NULL,

    INDEX `report_chat_report_uuid_at_idx`(`report_uuid`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `punishment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `account_id` INTEGER NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `issued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `until` DATETIME(3) NULL,
    `automated` BOOLEAN NOT NULL DEFAULT false,
    `issued_by_account_id` INTEGER NULL,
    `note` VARCHAR(191) NULL,
    `lifted_at` DATETIME(3) NULL,
    `lifted_by_account_id` INTEGER NULL,

    INDEX `punishment_issued_at_idx`(`issued_at` DESC),
    INDEX `punishment_account_id_idx`(`account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_spawn` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `staff_account_id` INTEGER NOT NULL,
    `target_account_id` INTEGER NULL,
    `item_id` INTEGER NOT NULL,
    `count` INTEGER NOT NULL,
    `world` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `staff_spawn_created_at_idx`(`created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `economy_snapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `taken_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `profile` VARCHAR(191) NOT NULL,
    `players` INTEGER NOT NULL,
    `coins` BIGINT NOT NULL,
    `items` TEXT NOT NULL,
    `tracked` TEXT NOT NULL,

    INDEX `economy_snapshot_profile_taken_at_idx`(`profile`, `taken_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `economy_flow` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `taken_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `profile` VARCHAR(191) NOT NULL,
    `item_id` INTEGER NOT NULL,
    `delta` INTEGER NOT NULL,

    INDEX `economy_flow_profile_taken_at_idx`(`profile`, `taken_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `session_wealth_timestamp_idx` ON `session_wealth`(`timestamp`);

-- CreateIndex
CREATE INDEX `session_wealth_session_uuid_timestamp_idx` ON `session_wealth`(`session_uuid`, `timestamp`);

-- CreateIndex
CREATE INDEX `public_chat_timestamp_idx` ON `public_chat`(`timestamp`);

-- CreateIndex
CREATE INDEX `public_chat_session_uuid_timestamp_idx` ON `public_chat`(`session_uuid`, `timestamp`);

-- CreateIndex
CREATE INDEX `private_chat_timestamp_idx` ON `private_chat`(`timestamp`);

-- CreateIndex
CREATE INDEX `private_chat_account_id_timestamp_idx` ON `private_chat`(`account_id`, `timestamp`);

-- CreateIndex
CREATE INDEX `report_uuid_idx` ON `report`(`uuid`);

-- CreateIndex
CREATE INDEX `report_offender_account_id_timestamp_idx` ON `report`(`offender_account_id`, `timestamp` DESC);
