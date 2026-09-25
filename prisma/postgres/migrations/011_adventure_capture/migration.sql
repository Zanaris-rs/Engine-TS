-- 011_adventure_capture: what the Adventurer Log is made of, as the login
-- server records it.
--
-- The game already narrates a player's adventures: every level gained, every
-- 250 total levels, every quest, clue scroll, rare drop and random event
-- writes an ADVENTURE session log (`Player.addSessionLog`, and
-- `session_log(^log_adventure, ...)` in content). The fleet runs with the
-- session log off, so until now those lines went nowhere. The engine now keeps
-- them on the Player and hands them to the login server with each save; this
-- is where they land.
--
-- ## adventure_event
--
-- One row per line, stored **only after the save it rode in with was
-- written** (LoginServer.ts, the player_autosave and player_logout branches).
-- A world that crashes rolls its players back to their last save, and so the
-- log never shows a level or a drop the save does not have.
--
-- - `(session_uuid, seq)` is unique: `seq` counts a session's lines from 0,
--   and a logout the world retries until the login server answers sends the
--   same lines again. The second insert does nothing.
-- - `category` is decided by the login server from the line's wording
--   (`src/server/login/Adventure.ts`): 0 other, 1 level, 2 milestone,
--   3 quest, 4 drop, 5 clue, 6 random event, 7 tutorial. The text is kept as
--   written, so a category can be corrected later with an UPDATE.
-- - Staff above level 1 and banned accounts get no rows, the same accounts
--   `updateHiscores` skips: `::advancestat` is not an adventure.
--
-- ## account_look
--
-- One row per account and profile: the player's body and what they had on at
-- their last save - gender, the seven identity kits, the five colours and the
-- fourteen worn slots. The website's "import from game" copies it into an
-- outfit. JSON arrays in text columns, because all three backends carry this
-- table and only one of them has arrays.
--
-- Written on every save, but only when something changed.
--
-- No functions here: the login server writes both tables through Kysely, and
-- the website reads them through the functions of later migrations. No
-- foreign keys, like every other table.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "adventure_event" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "session_uuid" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "category" INTEGER NOT NULL,
    "event" TEXT NOT NULL,

    CONSTRAINT "adventure_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "adventure_event_category" CHECK ("category" BETWEEN 0 AND 7),
    CONSTRAINT "adventure_event_seq" CHECK ("seq" >= 0),
    CONSTRAINT "adventure_event_length" CHECK (length("event") BETWEEN 1 AND 191)
);

CREATE TABLE IF NOT EXISTS "account_look" (
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "gender" INTEGER NOT NULL,
    "kits" TEXT NOT NULL,
    "colours" TEXT NOT NULL,
    "worn" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_look_pkey" PRIMARY KEY ("account_id", "profile"),
    CONSTRAINT "account_look_gender" CHECK ("gender" IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS "adventure_event_session_uuid_seq_key" ON "adventure_event"("session_uuid", "seq");
CREATE INDEX IF NOT EXISTS "adventure_event_account_id_profile_occurred_at_idx" ON "adventure_event"("account_id", "profile", "occurred_at" DESC);

ALTER TABLE "adventure_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_look" ENABLE ROW LEVEL SECURITY;

-- rollback:
--
-- Drops both tables and every line in them. The engine keeps writing (and
-- logs each failure) until it is rolled back too.
--
-- DROP TABLE IF EXISTS "account_look";
-- DROP TABLE IF EXISTS "adventure_event";
