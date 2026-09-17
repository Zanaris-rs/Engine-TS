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
    "members" BOOLEAN NOT NULL DEFAULT false,
    "invites_enabled" BOOLEAN NOT NULL DEFAULT false
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
    "reason" INTEGER NOT NULL,
    "reporter_account_id" INTEGER,
    "world" INTEGER,
    "uuid" TEXT,
    "offender_account_id" INTEGER,
    "offender_session_uuid" TEXT,
    "offender_coord" INTEGER,
    "resolved_at" DATETIME,
    "resolution" TEXT,
    "resolved_by_account_id" INTEGER,
    "staff_note" TEXT
);

-- CreateTable
CREATE TABLE "input_report" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_uuid" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "data" BLOB NOT NULL
);

-- CreateTable
CREATE TABLE "account_message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "ticket_id" INTEGER,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_account_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" DATETIME
);

-- CreateTable
CREATE TABLE "ticket" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ticket_message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ticket_id" INTEGER NOT NULL,
    "author_account_id" INTEGER NOT NULL,
    "from_staff" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "staff_action" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "actor_account_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "report_input" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "report_uuid" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL,
    "flushed_at" DATETIME NOT NULL,
    "data" BLOB NOT NULL
);

-- CreateTable
CREATE TABLE "report_chat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "report_uuid" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "to_username" TEXT,
    "coord" INTEGER NOT NULL,
    "message" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "punishment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "issued_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" DATETIME,
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "issued_by_account_id" INTEGER,
    "note" TEXT,
    "lifted_at" DATETIME,
    "lifted_by_account_id" INTEGER
);

-- CreateTable
CREATE TABLE "staff_spawn" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "staff_account_id" INTEGER NOT NULL,
    "target_account_id" INTEGER,
    "item_id" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,
    "world" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "economy_snapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taken_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile" TEXT NOT NULL,
    "players" INTEGER NOT NULL,
    "coins" BIGINT NOT NULL,
    "items" TEXT NOT NULL,
    "tracked" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "economy_flow" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taken_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile" TEXT NOT NULL,
    "item_id" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "invite" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "created_by_account_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "claimed_by_account_id" INTEGER,
    "claimed_at" DATETIME,
    "revoked_at" DATETIME,
    "revoked_reason" TEXT
);

-- CreateTable
CREATE TABLE "invite_attempt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ip" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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

-- CreateIndex
CREATE INDEX "session_wealth_timestamp_idx" ON "session_wealth"("timestamp");

-- CreateIndex
CREATE INDEX "session_wealth_session_uuid_timestamp_idx" ON "session_wealth"("session_uuid", "timestamp");

-- CreateIndex
CREATE INDEX "public_chat_timestamp_idx" ON "public_chat"("timestamp");

-- CreateIndex
CREATE INDEX "public_chat_session_uuid_timestamp_idx" ON "public_chat"("session_uuid", "timestamp");

-- CreateIndex
CREATE INDEX "private_chat_timestamp_idx" ON "private_chat"("timestamp");

-- CreateIndex
CREATE INDEX "private_chat_account_id_timestamp_idx" ON "private_chat"("account_id", "timestamp");

-- CreateIndex
CREATE INDEX "report_timestamp_idx" ON "report"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "report_uuid_idx" ON "report"("uuid");

-- CreateIndex
CREATE INDEX "report_offender_account_id_timestamp_idx" ON "report"("offender_account_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "account_message_account_id_read_at_idx" ON "account_message"("account_id", "read_at");

-- CreateIndex
CREATE INDEX "account_message_account_id_created_at_idx" ON "account_message"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_account_id_updated_at_idx" ON "ticket"("account_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_status_updated_at_idx" ON "ticket"("status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_message_ticket_id_created_at_idx" ON "ticket_message"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "ticket_message_author_account_id_created_at_idx" ON "ticket_message"("author_account_id", "created_at");

-- CreateIndex
CREATE INDEX "staff_action_actor_account_id_action_created_at_idx" ON "staff_action"("actor_account_id", "action", "created_at");

-- CreateIndex
CREATE INDEX "report_input_report_uuid_seq_idx" ON "report_input"("report_uuid", "seq");

-- CreateIndex
CREATE INDEX "report_chat_report_uuid_at_idx" ON "report_chat"("report_uuid", "at");

-- CreateIndex
CREATE INDEX "punishment_issued_at_idx" ON "punishment"("issued_at" DESC);

-- CreateIndex
CREATE INDEX "punishment_account_id_idx" ON "punishment"("account_id");

-- CreateIndex
CREATE INDEX "staff_spawn_created_at_idx" ON "staff_spawn"("created_at" DESC);

-- CreateIndex
CREATE INDEX "economy_snapshot_profile_taken_at_idx" ON "economy_snapshot"("profile", "taken_at" DESC);

-- CreateIndex
CREATE INDEX "economy_flow_profile_taken_at_idx" ON "economy_flow"("profile", "taken_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "invite_code_key" ON "invite"("code");

-- CreateIndex
CREATE INDEX "invite_created_by_account_id_created_at_idx" ON "invite"("created_by_account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invite_claimed_by_account_id_idx" ON "invite"("claimed_by_account_id");

-- CreateIndex
CREATE INDEX "invite_attempt_ip_created_at_idx" ON "invite_attempt"("ip", "created_at");

