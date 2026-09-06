-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ipban" (
    "ip" TEXT NOT NULL,

    CONSTRAINT "ipban_pkey" PRIMARY KEY ("ip")
);

-- CreateTable
CREATE TABLE "account" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "registration_ip" TEXT,
    "registration_group" TEXT,
    "registration_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signup_agent_hash" TEXT,
    "muted_until" TIMESTAMPTZ(3),
    "banned_until" TIMESTAMPTZ(3),
    "playable_after" TIMESTAMPTZ(3),
    "staffmodlevel" INTEGER NOT NULL DEFAULT 0,
    "members" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_attempt" (
    "id" SERIAL NOT NULL,
    "ip" TEXT NOT NULL,
    "ip_group" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_login" (
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "logged_in" INTEGER NOT NULL DEFAULT 0,
    "login_time" TIMESTAMPTZ(3),
    "logged_out" INTEGER NOT NULL DEFAULT 0,
    "logout_time" TIMESTAMPTZ(3),

    CONSTRAINT "account_login_pkey" PRIMARY KEY ("profile","account_id")
);

-- CreateTable
CREATE TABLE "hiscore" (
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "type" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hiscore_pkey" PRIMARY KEY ("profile","type","account_id")
);

-- CreateTable
CREATE TABLE "hiscore_large" (
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "type" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "value" BIGINT NOT NULL,
    "date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hiscore_large_pkey" PRIMARY KEY ("profile","type","account_id")
);

-- CreateTable
CREATE TABLE "friendlist" (
    "account_id" INTEGER NOT NULL,
    "friend_account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "created" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendlist_pkey" PRIMARY KEY ("profile","account_id","friend_account_id")
);

-- CreateTable
CREATE TABLE "ignorelist" (
    "account_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "created" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ignorelist_pkey" PRIMARY KEY ("profile","account_id","value")
);

-- CreateTable
CREATE TABLE "session" (
    "uuid" TEXT NOT NULL,
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "world" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "uid" INTEGER NOT NULL,
    "ip" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("uuid")
);

-- CreateTable
CREATE TABLE "session_log" (
    "id" SERIAL NOT NULL,
    "session_uuid" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "coord" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "event_type" INTEGER NOT NULL DEFAULT -1,

    CONSTRAINT "session_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_wealth" (
    "id" SERIAL NOT NULL,
    "session_uuid" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "coord" INTEGER NOT NULL,
    "event_type" INTEGER NOT NULL DEFAULT -1,
    "account_items" TEXT NOT NULL,
    "account_value" INTEGER NOT NULL,
    "recipient_session" TEXT,
    "recipient_items" TEXT,
    "recipient_value" INTEGER,

    CONSTRAINT "session_wealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_chat" (
    "id" SERIAL NOT NULL,
    "session_uuid" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "coord" INTEGER NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "public_chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_chat" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "coord" INTEGER NOT NULL,
    "to_account_id" INTEGER NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "private_chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" SERIAL NOT NULL,
    "session_uuid" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "coord" INTEGER NOT NULL,
    "offender" TEXT NOT NULL,
    "reason" INTEGER NOT NULL,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "input_report" (
    "id" SERIAL NOT NULL,
    "session_uuid" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "input_report_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "hiscore_profile_type_value_idx" ON "hiscore"("profile", "type", "value" DESC);

-- CreateIndex
CREATE INDEX "hiscore_large_profile_type_value_idx" ON "hiscore_large"("profile", "type", "value" DESC);


-- ---------------------------------------------------------------------------
-- Everything below this line is hand-written and is NOT regenerated by
-- `prisma migrate diff`. If the models above change, regenerate the top half
-- and paste this tail back underneath it.
--
-- Three things live down here:
--   1. row level security on every table, so PostgREST's anon/authenticated
--      roles - which Supabase grants on new public objects - see nothing;
--   2. the hiscores and accounts schemas, which PostgREST does not expose, and
--      which hold the only surface the website is allowed to touch;
--   3. the `website` role, which has SELECT on two views and EXECUTE on two
--      functions and no table privileges at all - not even INSERT on account.
-- ---------------------------------------------------------------------------

-- RLS with no policies denies everything to every role except the table owner,
-- which is how the hub (connecting as postgres) keeps working unchanged.
ALTER TABLE "ipban" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signup_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_login" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hiscore" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hiscore_large" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "friendlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ignorelist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_wealth" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_chat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "private_chat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "input_report" ENABLE ROW LEVEL SECURITY;

-- prisma creates this before it applies anything, but a database seeded some
-- other way will not have it
DO $$
BEGIN
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
        EXECUTE 'ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- hiscores: owner-rights views, the only rows the website may read
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS hiscores;

-- These views deliberately run with the *owner's* rights (the default for a
-- view, i.e. security_invoker off), which is what lets a role with no
-- privileges on public.account read the joined username while RLS keeps it out
-- of the table itself.
CREATE OR REPLACE VIEW hiscores.hiscore_public AS
SELECT h.profile,
       h.type,
       h.account_id,
       a.username,
       h.level,
       h.value,
       h.date
FROM public.hiscore h
JOIN public.account a ON a.id = h.account_id
WHERE a.staffmodlevel <= 1
  AND (a.banned_until IS NULL OR a.banned_until < now());

CREATE OR REPLACE VIEW hiscores.hiscore_large_public AS
SELECT h.profile,
       h.type,
       h.account_id,
       a.username,
       h.level,
       h.value,
       h.date
FROM public.hiscore_large h
JOIN public.account a ON a.id = h.account_id
WHERE a.staffmodlevel <= 1
  AND (a.banned_until IS NULL OR a.banned_until < now());

-- ---------------------------------------------------------------------------
-- accounts: the registration function, and its reaper
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS accounts;

-- Called by the website with an already-computed bcrypt hash: the plaintext
-- never reaches postgres, and pgcrypto's crypt() is deliberately not used
-- because its output would have to stay byte-compatible with bcrypt-ts forever.
--
-- Returns 'ok', 'username_taken' or 'rate_limited'. This signature is a
-- cross-repo contract - the website calls it positionally.
--
-- Caps: 3 per ip per 10 minutes, 3 per ip per day, 10 per /24 (or /64) per day.
-- The attempt row is written on every call, rejected ones included, so
-- hammering the endpoint still counts against the caps.
--
-- app.soak_minutes delays when a new account may log in (LoginServer checks
-- playable_after). Off unless set, e.g.
--   ALTER DATABASE postgres SET app.soak_minutes = '60';
CREATE OR REPLACE FUNCTION accounts.register(
    p_username text,
    p_email text,
    p_email_normalized text,
    p_password_hash text,
    p_ip text,
    p_ip_group text,
    p_agent_hash text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_soak_minutes int := coalesce(nullif(current_setting('app.soak_minutes', true), '')::int, 0);
    v_ip_recent int;
    v_ip_day int;
    v_group_day int;
BEGIN
    SELECT count(*) INTO v_ip_recent
    FROM public.signup_attempt
    WHERE ip = p_ip AND created_at > now() - interval '10 minutes';

    SELECT count(*) INTO v_ip_day
    FROM public.signup_attempt
    WHERE ip = p_ip AND created_at > now() - interval '1 day';

    SELECT count(*) INTO v_group_day
    FROM public.signup_attempt
    WHERE ip_group = p_ip_group AND created_at > now() - interval '1 day';

    INSERT INTO public.signup_attempt (ip, ip_group) VALUES (p_ip, p_ip_group);

    IF v_ip_recent >= 3 OR v_ip_day >= 3 OR v_group_day >= 10 THEN
        RETURN 'rate_limited';
    END IF;

    IF EXISTS (SELECT 1 FROM public.account WHERE username = p_username) THEN
        RETURN 'username_taken';
    END IF;

    -- a nested block, so losing the race to the unique index rolls back only
    -- this insert and leaves the attempt row above counted
    BEGIN
        INSERT INTO public.account (
            username,
            password,
            email,
            email_normalized,
            registration_ip,
            registration_group,
            registration_date,
            signup_agent_hash,
            playable_after,
            staffmodlevel
        ) VALUES (
            p_username,
            p_password_hash,
            p_email,
            p_email_normalized,
            p_ip,
            p_ip_group,
            now(),
            p_agent_hash,
            CASE WHEN v_soak_minutes > 0 THEN now() + make_interval(mins => v_soak_minutes) ELSE NULL END,
            0
        );
    EXCEPTION
        WHEN unique_violation THEN
            RETURN 'username_taken';
    END;

    RETURN 'ok';
END;
$$;

-- Signup attempts are rate-limit state, not history: nothing reads them beyond
-- the 24 hour window.
CREATE OR REPLACE FUNCTION accounts.reap() RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deleted bigint;
BEGIN
    DELETE FROM public.signup_attempt WHERE created_at < now() - interval '24 hours';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- ---------------------------------------------------------------------------
-- the website role
-- ---------------------------------------------------------------------------

-- NOLOGIN here on purpose. The password is set by hand, once, in the Supabase
-- SQL editor and never committed:
--   ALTER ROLE website LOGIN PASSWORD '...';
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'website') THEN
        CREATE ROLE website NOLOGIN;
    END IF;
END
$$;

REVOKE ALL ON SCHEMA hiscores FROM PUBLIC;
REVOKE ALL ON SCHEMA accounts FROM PUBLIC;

GRANT USAGE ON SCHEMA hiscores TO website;
GRANT USAGE ON SCHEMA accounts TO website;

GRANT SELECT ON hiscores.hiscore_public TO website;
GRANT SELECT ON hiscores.hiscore_large_public TO website;

-- functions are EXECUTE-able by PUBLIC by default, and these two are SECURITY
-- DEFINER, so the default is revoked before anything is granted
REVOKE ALL ON FUNCTION accounts.register(text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.reap() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.register(text, text, text, text, text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.reap() TO website;

-- Deliberately absent: any grant at all on schema public or the tables in it.
-- A route handler holding the website credentials cannot read a password hash,
-- set staffmodlevel, clear banned_until or flip members, whatever it asks for.

-- ---------------------------------------------------------------------------
-- the reaper's schedule
-- ---------------------------------------------------------------------------

-- pg_cron keeps the whole lifecycle inside the database, with no Vercel cron to
-- forget about. It has to be enabled for the project first (Supabase dashboard,
-- Database > Extensions); if it is not, the rest of the migration still applies
-- and only the reaper is missing.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            CREATE EXTENSION pg_cron;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING 'pg_cron could not be enabled (%), so signup_attempt rows will not be reaped. Enable it in the Supabase dashboard, then run: select cron.schedule(''reap'', ''0 * * * *'', ''select accounts.reap()'');', SQLERRM;
                RETURN;
        END;
    END IF;

    IF EXISTS (SELECT FROM cron.job WHERE jobname = 'reap') THEN
        PERFORM cron.unschedule('reap');
    END IF;

    PERFORM cron.schedule('reap', '0 * * * *', 'select accounts.reap()');
END
$$;
