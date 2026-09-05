-- CreateTable
CREATE TABLE "ipban" (
    "ip" TEXT NOT NULL PRIMARY KEY
);

-- CreateTable
CREATE TABLE "account" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "registration_ip" TEXT,
    "registration_group" TEXT,
    "registration_date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signup_agent_hash" TEXT,
    "muted_until" DATETIME,
    "banned_until" DATETIME,
    "playable_after" DATETIME,
    "staffmodlevel" INTEGER NOT NULL DEFAULT 0,
    "members" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "signup_attempt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ip" TEXT NOT NULL,
    "ip_group" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "login_attempt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "account_login" (
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "logged_in" INTEGER NOT NULL DEFAULT 0,
    "login_time" DATETIME,
    "logged_out" INTEGER NOT NULL DEFAULT 0,
    "logout_time" DATETIME,

    PRIMARY KEY ("profile", "account_id")
);

-- CreateTable
CREATE TABLE "hiscore" (
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "type" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("profile", "type", "account_id")
);

-- CreateTable
CREATE TABLE "hiscore_large" (
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "type" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "value" BIGINT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("profile", "type", "account_id")
);

-- CreateTable
CREATE TABLE "friendlist" (
    "account_id" INTEGER NOT NULL,
    "friend_account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "created" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("profile", "account_id", "friend_account_id")
);

-- CreateTable
CREATE TABLE "ignorelist" (
    "account_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "created" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("profile", "account_id", "value")
);

-- CreateTable
CREATE TABLE "session" (
    "uuid" TEXT NOT NULL PRIMARY KEY,
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "world" INTEGER NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "uid" INTEGER NOT NULL,
    "ip" TEXT
);

-- CreateTable
CREATE TABLE "session_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_uuid" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "coord" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "event_type" INTEGER NOT NULL DEFAULT -1
);

-- CreateTable
CREATE TABLE "session_wealth" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_uuid" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "coord" INTEGER NOT NULL,
    "event_type" INTEGER NOT NULL DEFAULT -1,
    "account_items" TEXT NOT NULL,
    "account_value" INTEGER NOT NULL,
    "recipient_session" TEXT,
    "recipient_items" TEXT,
    "recipient_value" INTEGER
);

-- CreateTable
CREATE TABLE "public_chat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_uuid" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "coord" INTEGER NOT NULL,
    "message" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "private_chat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "coord" INTEGER NOT NULL,
    "to_account_id" INTEGER NOT NULL,
    "message" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "report" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_uuid" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "coord" INTEGER NOT NULL,
    "offender" TEXT NOT NULL,
    "reason" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "input_report" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_uuid" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "data" BLOB NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "account_username_key" ON "account"("username");

-- CreateIndex
CREATE INDEX "account_email_normalized_idx" ON "account"("email_normalized");

-- CreateIndex
CREATE INDEX "account_registration_ip_idx" ON "account"("registration_ip");

-- CreateIndex
CREATE INDEX "account_registration_group_idx" ON "account"("registration_group");

-- CreateIndex
CREATE INDEX "signup_attempt_ip_created_at_idx" ON "signup_attempt"("ip", "created_at");

-- CreateIndex
CREATE INDEX "signup_attempt_ip_group_created_at_idx" ON "signup_attempt"("ip_group", "created_at");

-- CreateIndex
CREATE INDEX "login_attempt_username_created_at_idx" ON "login_attempt"("username", "created_at");

-- CreateIndex
CREATE INDEX "login_attempt_ip_created_at_idx" ON "login_attempt"("ip", "created_at");

-- CreateIndex
CREATE INDEX "session_profile_account_id_timestamp_idx" ON "session"("profile", "account_id", "timestamp" DESC);
