-- 4_evidence_and_records: macro report evidence, the public punishment record,
-- staff item spawns and the economy census.
--
-- Same shape as 2_website_login and 3_message_centre. No foreign keys, RLS on
-- with no policies, no grant of any kind on schema public or the tables in it:
-- the website reaches these rows only through the SECURITY DEFINER functions
-- that task M4b appends to the bottom of this file, and a leaked `website`
-- credential can still do nothing with `select * from report_input`.
--
-- Why each table exists:
--
--   report_input / report_chat  A Report Abuse row used to be a sentence with
--                               no evidence behind it. `report.uuid` is a
--                               world-generated key carried by both the login
--                               server (the report row) and the logger server
--                               (the evidence), so the two hub processes need
--                               no ordering between them and nothing has to
--                               join a time window across the log tables.
--                               Evidence lives 30 days, or until staff dismiss
--                               the report; reap() enforces both in M4b.
--   punishment                  A permanent, public record of every ban and
--                               mute: what happened, when, until when, and
--                               whether it was lifted. The issuing moderator's
--                               id is stored but never leaves the database -
--                               the public read function shows "a moderator"
--                               or "automated" and nothing more.
--   staff_spawn                 Every item a staff member creates on a
--                               production world, so the economy census can
--                               say "added by staff" instead of leaving a
--                               step in the totals unexplained.
--   economy_snapshot / _flow    The hourly census of every save file: totals
--                               plus a per-item map, and the per-item delta
--                               against the previous snapshot. Nothing here
--                               names an account; the flow rows say an item
--                               entered or left the game, not who holds it.
--
-- `report.uuid` is nullable and its index is not unique: every report written
-- before this migration has no uuid, and one uuid legitimately covers several
-- reports when more than one player reports the same macroer inside the same
-- capture window.

-- ---------------------------------------------------------------------------
-- report: the evidence key, who was reported, and the resolution trail
-- ---------------------------------------------------------------------------

-- All nullable, for the same reason reporter_account_id and world are in
-- 3_message_centre: the rows already in this table know none of it, and the
-- offender ids are only resolvable when the offender has an account (and, for
-- the session and coord, when they were online at the time).
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "uuid" TEXT;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "offender_account_id" INTEGER;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "offender_session_uuid" TEXT;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "offender_coord" INTEGER;

-- resolution is actioned | dismissed | watch, null while the report is open.
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMPTZ(3);
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "resolution" TEXT;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "resolved_by_account_id" INTEGER;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "staff_note" TEXT;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

-- One row per input chunk the logger server was handed. kind is ring (a chunk
-- that had already rotated out of the player's ring when the report arrived)
-- or live (a chunk captured after it); client is web | java; seq orders the
-- chunks within one report and data is the engine's own record framing,
-- decoded by the website, never by the database.
CREATE TABLE IF NOT EXISTS "report_input" (
    "id" SERIAL NOT NULL,
    "report_uuid" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "flushed_at" TIMESTAMPTZ(3) NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "report_input_pkey" PRIMARY KEY ("id")
);

-- The offender's own chat in the report window, copied out of public_chat and
-- private_chat before the hourly sweep deletes it. kind is public or
-- private_sent; to_username is null on a public row.
CREATE TABLE IF NOT EXISTS "report_chat" (
    "id" SERIAL NOT NULL,
    "report_uuid" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "to_username" TEXT,
    "coord" INTEGER NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "report_chat_pkey" PRIMARY KEY ("id")
);

-- kind is ban | mute. `until` null is permanent. automated is true when the
-- engine issued it rather than a person, and issued_by_account_id is then
-- null; neither is ever shown to the public. note is the optional one-line
-- public explanation, lifted_at/lifted_by are set when it is reversed - the
-- row itself is never deleted, which is the point of a public record.
CREATE TABLE IF NOT EXISTS "punishment" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" TIMESTAMPTZ(3),
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "issued_by_account_id" INTEGER,
    "note" TEXT,
    "lifted_at" TIMESTAMPTZ(3),
    "lifted_by_account_id" INTEGER,

    CONSTRAINT "punishment_pkey" PRIMARY KEY ("id")
);

-- target_account_id is null when the cheat named someone the login server
-- could not resolve to an account; the spawn still happened, so the row is
-- still written.
CREATE TABLE IF NOT EXISTS "staff_spawn" (
    "id" SERIAL NOT NULL,
    "staff_account_id" INTEGER NOT NULL,
    "target_account_id" INTEGER,
    "item_id" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,
    "world" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_spawn_pkey" PRIMARY KEY ("id")
);

-- items is the whole census as {item_id: count}; tracked is the subset named
-- in data/config/economy.json, stored beside it so the public page needs no
-- second lookup and so a later edit to that list cannot rewrite history.
-- coins is bigint: item 995 across every save passes 2^31 long before the
-- player count does anything interesting.
CREATE TABLE IF NOT EXISTS "economy_snapshot" (
    "id" SERIAL NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile" TEXT NOT NULL,
    "players" INTEGER NOT NULL,
    "coins" BIGINT NOT NULL,
    "items" JSONB NOT NULL,
    "tracked" JSONB NOT NULL,

    CONSTRAINT "economy_snapshot_pkey" PRIMARY KEY ("id")
);

-- delta is signed: positive entered the game since the previous snapshot,
-- negative left it.
CREATE TABLE IF NOT EXISTS "economy_flow" (
    "id" SERIAL NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile" TEXT NOT NULL,
    "item_id" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,

    CONSTRAINT "economy_flow_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------

-- Not unique: one uuid covers every report filed against the same offender
-- inside one capture window, and the rows written before this migration have
-- no uuid at all.
CREATE INDEX IF NOT EXISTS "report_uuid_idx" ON "report"("uuid");
CREATE INDEX IF NOT EXISTS "report_offender_account_id_timestamp_idx" ON "report"("offender_account_id", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS "report_input_report_uuid_seq_idx" ON "report_input"("report_uuid", "seq");
CREATE INDEX IF NOT EXISTS "report_chat_report_uuid_at_idx" ON "report_chat"("report_uuid", "at");

-- The log tables have been unindexed since 0_init, and they now have both a
-- reader and a reaper. The bare timestamp index is the retention sweep's
-- (1 hour for chat, 7 days for wealth); the compound ones are how the evidence
-- functions find one player's rows inside a report window.
CREATE INDEX IF NOT EXISTS "session_wealth_timestamp_idx" ON "session_wealth"("timestamp");
CREATE INDEX IF NOT EXISTS "session_wealth_session_uuid_timestamp_idx" ON "session_wealth"("session_uuid", "timestamp");
CREATE INDEX IF NOT EXISTS "public_chat_timestamp_idx" ON "public_chat"("timestamp");
CREATE INDEX IF NOT EXISTS "public_chat_session_uuid_timestamp_idx" ON "public_chat"("session_uuid", "timestamp");
CREATE INDEX IF NOT EXISTS "private_chat_timestamp_idx" ON "private_chat"("timestamp");
CREATE INDEX IF NOT EXISTS "private_chat_account_id_timestamp_idx" ON "private_chat"("account_id", "timestamp");

CREATE INDEX IF NOT EXISTS "punishment_issued_at_idx" ON "punishment"("issued_at" DESC);
CREATE INDEX IF NOT EXISTS "punishment_account_id_idx" ON "punishment"("account_id");
CREATE INDEX IF NOT EXISTS "staff_spawn_created_at_idx" ON "staff_spawn"("created_at" DESC);
CREATE INDEX IF NOT EXISTS "economy_snapshot_profile_taken_at_idx" ON "economy_snapshot"("profile", "taken_at" DESC);
CREATE INDEX IF NOT EXISTS "economy_flow_profile_taken_at_idx" ON "economy_flow"("profile", "taken_at" DESC);

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------
--
-- On, with no policies, matching 0_init and 3_message_centre: nothing reaches
-- these rows except through a SECURITY DEFINER function running as the owner.

ALTER TABLE "report_input" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_chat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "punishment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_spawn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "economy_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "economy_flow" ENABLE ROW LEVEL SECURITY;

-- === functions (task M4b) ===
--
-- The staff and public read functions, the resolve/lift writers, the REVOKE
-- and GRANT block and the replacement reap() are appended below this line by
-- task M4b. This file is applied once, as a whole, after both halves exist -
-- nothing above has run against any database yet.
