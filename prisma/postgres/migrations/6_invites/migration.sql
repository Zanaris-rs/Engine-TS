-- 6_invites: an account is something you are let into.
--
-- Until this migration anybody who passed Turnstile and the signup caps could
-- make an account. After it, registration needs a single-use invite link from
-- an account staff have trusted to hand them out, and `accounts.register` is
-- no longer something the website can call at all.
--
-- ## The rules, in one place
--
-- - `account.invites_enabled` is false for every account, old and new, until
--   staff switch it on (`accounts.staff_set_invites`, or
--   `tools/server/account.ts invite-enable`). Nothing in the registration
--   path ever sets it.
-- - An enabled account can mint as many links as it likes, but holds at most
--   twenty live links at once and mints at most a hundred a day. Those caps
--   stop a spray; they are not a ration.
-- - A link is sixteen Crockford base32 characters, lives fourteen days, and
--   lets exactly one account in.
-- - A link stops working when it is claimed, cancelled by its maker, revoked
--   by staff switching the maker's inviting off, revoked by the maker being
--   banned, or when it expires. A link whose maker is disabled or banned
--   right now is dead even if no row says so.
-- - Who invited whom is `invite.claimed_by_account_id` ->
--   `created_by_account_id`. Claimed rows are never deleted: they are the
--   invite tree staff use to find alts.
-- - The citizen number the site shows is `account.id`.
--
-- No foreign keys, like every other table here.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "invites_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "invite" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "created_by_account_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "claimed_by_account_id" INTEGER,
    "claimed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,

    CONSTRAINT "invite_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invite_code_format" CHECK ("code" ~ '^[0-9A-HJKMNP-TV-Z]{16}$'),
    CONSTRAINT "invite_revoked_reason" CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN ('inviter', 'staff', 'banned'))
);

-- Guessed codes, by address. invite_preview and register_with_invite both
-- count these, and reap() keeps an hour of them.
CREATE TABLE IF NOT EXISTS "invite_attempt" (
    "id" SERIAL NOT NULL,
    "ip" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_attempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "invite_code_key" ON "invite"("code");
CREATE INDEX IF NOT EXISTS "invite_created_by_account_id_created_at_idx" ON "invite"("created_by_account_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "invite_claimed_by_account_id_idx" ON "invite"("claimed_by_account_id");
CREATE INDEX IF NOT EXISTS "invite_attempt_ip_created_at_idx" ON "invite_attempt"("ip", "created_at");

ALTER TABLE "invite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invite_attempt" ENABLE ROW LEVEL SECURITY;

-- === functions (task A2) ===
