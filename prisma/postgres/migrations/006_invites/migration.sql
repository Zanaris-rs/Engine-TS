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

-- ---------------------------------------------------------------------------
-- internal helpers: NOT granted to website
-- ---------------------------------------------------------------------------

-- Can this account's links be claimed right now? Its flag is on and it is not
-- serving a ban. Read at claim time as well as stamped at switch-off time, so
-- a flag flipped by hand in psql still kills the links it should.
CREATE OR REPLACE FUNCTION accounts.invite_maker_ok(p_account_id int) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT coalesce((SELECT a.invites_enabled AND (a.banned_until IS NULL OR a.banned_until <= now())
                       FROM public.account a
                      WHERE a.id = p_account_id), false);
$$;

-- 'live' | 'claimed' | 'revoked' | 'expired'. Claimed wins over everything,
-- because a used link stays used whatever happens to its maker afterwards.
CREATE OR REPLACE FUNCTION accounts.invite_state(p_claimed_at timestamptz, p_revoked_at timestamptz,
                                                 p_expires_at timestamptz, p_maker_ok boolean) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE
        WHEN p_claimed_at IS NOT NULL THEN 'claimed'
        WHEN p_revoked_at IS NOT NULL OR NOT coalesce(p_maker_ok, false) THEN 'revoked'
        WHEN p_expires_at <= now() THEN 'expired'
        ELSE 'live'
    END;
$$;

-- ---------------------------------------------------------------------------
-- the door
-- ---------------------------------------------------------------------------

-- 'ok' | 'not_found' | 'claimed' | 'revoked' | 'expired' | 'rate_limited'.
--
-- What /join/<code> shows before anybody types anything. The maker's name
-- comes back only for a live link: a used link that was posted somewhere
-- public must not keep telling strangers who handed it out. A code that does
-- not exist is recorded against the address, and thirty of those in fifteen
-- minutes closes the door on that address for a while.
CREATE OR REPLACE FUNCTION accounts.invite_preview(p_code text, p_ip text)
RETURNS TABLE (result text, inviter text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_misses int;
    v_maker int;
    v_state text;
BEGIN
    SELECT count(*) INTO v_misses
      FROM public.invite_attempt ia
     WHERE ia.ip = coalesce(p_ip, '')
       AND ia.created_at > now() - interval '15 minutes';

    IF v_misses >= 30 THEN
        RETURN QUERY SELECT 'rate_limited'::text, NULL::text;
        RETURN;
    END IF;

    SELECT i.created_by_account_id,
           accounts.invite_state(i.claimed_at, i.revoked_at, i.expires_at,
                                 accounts.invite_maker_ok(i.created_by_account_id))
      INTO v_maker, v_state
      FROM public.invite i
     WHERE i.code = p_code;

    IF v_state IS NULL THEN
        INSERT INTO public.invite_attempt (ip) VALUES (coalesce(p_ip, ''));
        RETURN QUERY SELECT 'not_found'::text, NULL::text;
        RETURN;
    END IF;

    IF v_state <> 'live' THEN
        RETURN QUERY SELECT v_state, NULL::text;
        RETURN;
    END IF;

    RETURN QUERY
        SELECT 'ok'::text, a.username
          FROM public.account a
         WHERE a.id = v_maker;
END; $$;

-- 'ok' | 'invite_invalid' | 'invite_claimed' | 'invite_expired'
-- | 'invite_revoked' | 'username_taken' | 'rate_limited'.
--
-- accounts.register with a ticket. The same caps (3 per address per 10
-- minutes, 10 per day, 30 per /24 or /64 per day, charged only for an account
-- actually created), the same soak setting, the same welcome notice in the
-- same transaction - plus the guessing cap, and the claim of exactly one live
-- link. The account row, the claim and the charge are one statement from the
-- caller's side, so the transaction pooler cannot split them.
CREATE OR REPLACE FUNCTION accounts.register_with_invite(
    p_code text,
    p_username text,
    p_email text,
    p_email_normalized text,
    p_password_hash text,
    p_ip text,
    p_ip_group text,
    p_agent_hash text
) RETURNS TABLE (result text, citizen_number int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_soak_minutes int := coalesce(nullif(current_setting('app.soak_minutes', true), '')::int, 0);
    v_ip_recent int;
    v_ip_day int;
    v_group_day int;
    v_misses int;
    v_invite_id int;
    v_state text;
    v_account_id int;
BEGIN
    IF p_password_hash IS NULL OR p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
        RAISE EXCEPTION 'register_with_invite: p_password_hash is not a bcrypt hash';
    END IF;

    SELECT count(*) INTO v_ip_recent
      FROM public.signup_attempt sa
     WHERE sa.ip = p_ip AND sa.created_at > now() - interval '10 minutes';

    SELECT count(*) INTO v_ip_day
      FROM public.signup_attempt sa
     WHERE sa.ip = p_ip AND sa.created_at > now() - interval '1 day';

    SELECT count(*) INTO v_group_day
      FROM public.signup_attempt sa
     WHERE sa.ip_group = p_ip_group AND sa.created_at > now() - interval '1 day';

    SELECT count(*) INTO v_misses
      FROM public.invite_attempt ia
     WHERE ia.ip = coalesce(p_ip, '') AND ia.created_at > now() - interval '15 minutes';

    IF v_ip_recent >= 3 OR v_ip_day >= 10 OR v_group_day >= 30 OR v_misses >= 30 THEN
        RETURN QUERY SELECT 'rate_limited'::text, NULL::int;
        RETURN;
    END IF;

    -- One claim of a code at a time, and one registration of a name at a
    -- time. Transaction-scoped locks, which the :6543 pooler is safe with.
    PERFORM pg_advisory_xact_lock(hashtext('invite:' || coalesce(p_code, '')));
    PERFORM pg_advisory_xact_lock(hashtext('username:' || coalesce(p_username, '')));

    SELECT i.id,
           accounts.invite_state(i.claimed_at, i.revoked_at, i.expires_at,
                                 accounts.invite_maker_ok(i.created_by_account_id))
      INTO v_invite_id, v_state
      FROM public.invite i
     WHERE i.code = p_code
       FOR UPDATE;

    IF v_invite_id IS NULL THEN
        INSERT INTO public.invite_attempt (ip) VALUES (coalesce(p_ip, ''));
        RETURN QUERY SELECT 'invite_invalid'::text, NULL::int;
        RETURN;
    END IF;

    IF v_state <> 'live' THEN
        RETURN QUERY SELECT ('invite_' || v_state)::text, NULL::int;
        RETURN;
    END IF;

    -- A taken name leaves the link live: it is the name that was wrong.
    IF EXISTS (SELECT 1 FROM public.account a WHERE a.username = p_username) THEN
        RETURN QUERY SELECT 'username_taken'::text, NULL::int;
        RETURN;
    END IF;

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
        ) RETURNING id INTO v_account_id;
    EXCEPTION
        WHEN unique_violation THEN
            RETURN QUERY SELECT 'username_taken'::text, NULL::int;
            RETURN;
    END;

    UPDATE public.invite
       SET claimed_by_account_id = v_account_id,
           claimed_at = now()
     WHERE id = v_invite_id;

    INSERT INTO public.signup_attempt (ip, ip_group) VALUES (p_ip, p_ip_group);

    -- created_by_account_id null: nobody wrote this, the system did.
    INSERT INTO public.account_message (account_id, kind, subject, body)
    VALUES (
        v_account_id,
        'welcome',
        'Welcome to Zanaris',
        'Welcome to Zanaris.

This is your Message Centre. Notices from staff, replies to anything you report, and any ban or mute notice all arrive here, and the number of unread messages waiting for you is shown on the welcome screen every time you log in to the game.

Found a bug, or want to appeal a ban? Open a ticket from the Message Centre. Tell us which world you were on, roughly when it happened, what you were doing and what happened instead - that is what makes a report we can act on.

Nobody from Zanaris will ever ask you for your password. Have fun out there.'
    );

    RETURN QUERY SELECT 'ok'::text, v_account_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- a player's own links
-- ---------------------------------------------------------------------------

-- 'ok' | 'invalid' | 'disabled' | 'too_many' | 'retry'.
--
-- The site generates the code (ten random bytes, Crockford base32) and this
-- stores it. 'retry' is a collision on the unique index, which at eighty bits
-- means the caller should simply try another code.
CREATE OR REPLACE FUNCTION accounts.invite_create(p_username text, p_code text)
RETURNS TABLE (result text, code text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_account_id int;
    v_live int;
    v_today int;
    v_expires timestamptz := now() + interval '14 days';
BEGIN
    IF p_code IS NULL OR p_code !~ '^[0-9A-HJKMNP-TV-Z]{16}$' THEN
        RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::timestamptz;
        RETURN;
    END IF;

    SELECT a.id INTO v_account_id FROM public.account a WHERE a.username = p_username;

    IF v_account_id IS NULL OR NOT accounts.invite_maker_ok(v_account_id) THEN
        RETURN QUERY SELECT 'disabled'::text, NULL::text, NULL::timestamptz;
        RETURN;
    END IF;

    -- Two tabs pressing Create at once must not both squeeze under the cap.
    PERFORM pg_advisory_xact_lock(hashtext('invite_create:' || v_account_id));

    SELECT count(*) FILTER (WHERE i.claimed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()),
           count(*) FILTER (WHERE i.created_at > now() - interval '1 day')
      INTO v_live, v_today
      FROM public.invite i
     WHERE i.created_by_account_id = v_account_id;

    IF v_live >= 20 OR v_today >= 100 THEN
        RETURN QUERY SELECT 'too_many'::text, NULL::text, NULL::timestamptz;
        RETURN;
    END IF;

    BEGIN
        INSERT INTO public.invite (code, created_by_account_id, expires_at)
        VALUES (p_code, v_account_id, v_expires);
    EXCEPTION
        WHEN unique_violation THEN
            RETURN QUERY SELECT 'retry'::text, NULL::text, NULL::timestamptz;
            RETURN;
    END;

    RETURN QUERY SELECT 'ok'::text, p_code, v_expires;
END; $$;

-- 'ok' | 'not_found' | 'already_claimed'.
--
-- The maker cancelling one of their own live links. Somebody else's code, a
-- dead link and a code that never existed all answer 'not_found'.
CREATE OR REPLACE FUNCTION accounts.invite_revoke(p_username text, p_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_account_id int;
    v_invite_id int;
    v_claimed_at timestamptz;
    v_revoked_at timestamptz;
    v_expires_at timestamptz;
BEGIN
    SELECT a.id INTO v_account_id FROM public.account a WHERE a.username = p_username;
    IF v_account_id IS NULL THEN RETURN 'not_found'; END IF;

    PERFORM pg_advisory_xact_lock(hashtext('invite:' || coalesce(p_code, '')));

    SELECT i.id, i.claimed_at, i.revoked_at, i.expires_at
      INTO v_invite_id, v_claimed_at, v_revoked_at, v_expires_at
      FROM public.invite i
     WHERE i.code = p_code
       AND i.created_by_account_id = v_account_id
       FOR UPDATE;

    IF v_invite_id IS NULL THEN RETURN 'not_found'; END IF;
    IF v_claimed_at IS NOT NULL THEN RETURN 'already_claimed'; END IF;
    IF v_revoked_at IS NOT NULL OR v_expires_at <= now() THEN RETURN 'not_found'; END IF;

    UPDATE public.invite
       SET revoked_at = now(),
           revoked_reason = 'inviter'
     WHERE id = v_invite_id;

    RETURN 'ok';
END; $$;

-- One account's links, newest first. `state` is invite_state's word, so a
-- maker who has been switched off sees every unused link as revoked.
CREATE OR REPLACE FUNCTION accounts.invites(p_username text)
RETURNS TABLE (code text, created_at timestamptz, expires_at timestamptz,
               state text, claimed_by text, claimed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT i.code,
           i.created_at,
           i.expires_at,
           accounts.invite_state(i.claimed_at, i.revoked_at, i.expires_at, accounts.invite_maker_ok(a.id)),
           c.username,
           i.claimed_at
    FROM public.account a
    JOIN public.invite i ON i.created_by_account_id = a.id
    LEFT JOIN public.account c ON c.id = i.claimed_by_account_id
    WHERE a.username = p_username
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 200;
$$;

-- The account centre's header: the public number, the private flag, and the
-- private answer to "who let me in". Zero rows for a name nobody has.
CREATE OR REPLACE FUNCTION accounts.citizen(p_username text)
RETURNS TABLE (citizen_number int, invites_enabled boolean, invited_by text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.id,
           a.invites_enabled,
           (SELECT m.username
              FROM public.invite i
              JOIN public.account m ON m.id = i.created_by_account_id
             WHERE i.claimed_by_account_id = a.id
             ORDER BY i.claimed_at
             LIMIT 1)
    FROM public.account a
    WHERE a.username = p_username;
$$;

-- ---------------------------------------------------------------------------
-- staff
-- ---------------------------------------------------------------------------

-- 'ok' | 'forbidden' | 'bad_credentials' | 'rate_limited' | 'not_found' | 'invalid'.
--
-- The only way the website turns inviting on. Switching it off revokes every
-- live link in the same statement. Password re-typed, like staff_lift: a
-- leaked website credential must not be able to hand out the keys.
CREATE OR REPLACE FUNCTION accounts.staff_set_invites(p_actor text, p_candidate_hash text,
                                                      p_target text, p_enabled boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_actor_id int;
    v_password text;
    v_target_id int;
    v_target text;
BEGIN
    IF NOT accounts.is_staff(p_actor) THEN RETURN 'forbidden'; END IF;
    IF accounts.throttled('invites:' || p_actor, p_actor) THEN RETURN 'rate_limited'; END IF;

    SELECT a.id, a.password INTO v_actor_id, v_password FROM public.account a WHERE a.username = p_actor;

    IF p_candidate_hash IS NULL OR length(p_candidate_hash) <> 60
       OR v_password IS NULL OR v_password <> p_candidate_hash THEN
        PERFORM accounts.record_failure('invites:' || p_actor, p_actor);
        RETURN 'bad_credentials';
    END IF;

    IF p_enabled IS NULL THEN RETURN 'invalid'; END IF;

    SELECT a.id, a.username INTO v_target_id, v_target
      FROM public.account a
     WHERE a.username = p_target
       FOR UPDATE;
    IF v_target_id IS NULL THEN RETURN 'not_found'; END IF;

    UPDATE public.account SET invites_enabled = p_enabled WHERE id = v_target_id;

    IF NOT p_enabled THEN
        UPDATE public.invite
           SET revoked_at = now(),
               revoked_reason = 'staff'
         WHERE created_by_account_id = v_target_id
           AND claimed_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > now();
    END IF;

    INSERT INTO public.staff_action (actor_account_id, action, target)
    VALUES (v_actor_id, CASE WHEN p_enabled THEN 'invites_enabled' ELSE 'invites_disabled' END, v_target);

    RETURN 'ok';
END; $$;

-- One account, the account that let it in, and everybody it let in. Empty for
-- a caller who is not staff.
CREATE OR REPLACE FUNCTION accounts.staff_invite_tree(p_actor text, p_username text)
RETURNS TABLE (relation text, username text, citizen_number int, invites_enabled boolean,
               happened_at timestamptz, banned boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH target AS (
        SELECT a.id
        FROM public.account a
        WHERE a.username = p_username
          AND accounts.is_staff(p_actor)
    ),
    tree AS (
        SELECT 'self'::text AS relation, a.username, a.id AS citizen_number, a.invites_enabled,
               a.registration_date AS happened_at, coalesce(a.banned_until > now(), false) AS banned
        FROM target t
        JOIN public.account a ON a.id = t.id
        UNION ALL
        SELECT 'invited_by', m.username, m.id, m.invites_enabled,
               i.claimed_at, coalesce(m.banned_until > now(), false)
        FROM target t
        JOIN public.invite i ON i.claimed_by_account_id = t.id
        JOIN public.account m ON m.id = i.created_by_account_id
        UNION ALL
        SELECT 'invited', c.username, c.id, c.invites_enabled,
               i.claimed_at, coalesce(c.banned_until > now(), false)
        FROM target t
        JOIN public.invite i ON i.created_by_account_id = t.id
        JOIN public.account c ON c.id = i.claimed_by_account_id
    )
    SELECT tr.relation, tr.username, tr.citizen_number, tr.invites_enabled, tr.happened_at, tr.banned
    FROM tree tr
    ORDER BY CASE tr.relation WHEN 'self' THEN 0 WHEN 'invited_by' THEN 1 ELSE 2 END,
             tr.happened_at, tr.citizen_number
    LIMIT 500;
$$;

-- Every account that may invite right now, with what it has out and what it
-- has brought in. Empty for a caller who is not staff.
CREATE OR REPLACE FUNCTION accounts.staff_inviters(p_actor text)
RETURNS TABLE (username text, citizen_number int, live_links int, claimed_links int, banned boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.username,
           a.id,
           (count(i.id) FILTER (WHERE i.claimed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()))::int,
           count(i.claimed_at)::int,
           coalesce(a.banned_until > now(), false)
    FROM public.account a
    LEFT JOIN public.invite i ON i.created_by_account_id = a.id
    WHERE a.invites_enabled
      AND accounts.is_staff(p_actor)
    GROUP BY a.id
    ORDER BY a.id
    LIMIT 500;
$$;

-- ---------------------------------------------------------------------------
-- a ban takes the keys away
-- ---------------------------------------------------------------------------

-- A trigger rather than a line in each ban path, because there are several:
-- the website's staff functions, tools/server/account.ts, and the in-game
-- commands on the login server. Only a new ban that is in force fires it; a
-- lift (banned_until set to NULL) does not, and does not give the flag back.
CREATE OR REPLACE FUNCTION accounts.revoke_invites_on_ban() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    NEW.invites_enabled := false;

    UPDATE public.invite
       SET revoked_at = now(),
           revoked_reason = 'banned'
     WHERE created_by_account_id = NEW.id
       AND claimed_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now();

    RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS account_ban_revokes_invites ON public.account;
CREATE TRIGGER account_ban_revokes_invites
    BEFORE UPDATE OF banned_until ON public.account
    FOR EACH ROW
    WHEN (NEW.banned_until IS NOT NULL AND NEW.banned_until > now() AND NEW.banned_until IS DISTINCT FROM OLD.banned_until)
    EXECUTE FUNCTION accounts.revoke_invites_on_ban();

-- ---------------------------------------------------------------------------
-- retention
-- ---------------------------------------------------------------------------

-- Migration 4's reaper, same signature, its five rules unchanged, plus two:
-- an hour of guessed codes, and unused links ninety days after they expired.
-- Claimed links are the invite tree and are never deleted.
CREATE OR REPLACE FUNCTION accounts.reap() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_signups bigint; v_logins bigint; v_wealth bigint; v_input bigint; v_chat bigint;
        v_guesses bigint; v_links bigint;
BEGIN
    DELETE FROM public.signup_attempt WHERE created_at < now() - interval '24 hours';
    GET DIAGNOSTICS v_signups = ROW_COUNT;

    DELETE FROM public.login_attempt WHERE created_at < now() - interval '1 hour';
    GET DIAGNOSTICS v_logins = ROW_COUNT;

    -- Wealth events are adjudication material for a live report, not history.
    DELETE FROM public.session_wealth WHERE timestamp < now() - interval '7 days';
    GET DIAGNOSTICS v_wealth = ROW_COUNT;

    DELETE FROM public.report_input ri
     WHERE CASE WHEN EXISTS (SELECT 1 FROM public.report r WHERE r.uuid = ri.report_uuid)
                THEN NOT EXISTS (SELECT 1 FROM public.report r
                                  WHERE r.uuid = ri.report_uuid
                                    AND r.timestamp > now() - interval '30 days'
                                    AND r.resolution IS DISTINCT FROM 'dismissed')
                ELSE ri.flushed_at < now() - interval '30 days'
           END;
    GET DIAGNOSTICS v_input = ROW_COUNT;

    DELETE FROM public.report_chat rc
     WHERE CASE WHEN EXISTS (SELECT 1 FROM public.report r WHERE r.uuid = rc.report_uuid)
                THEN NOT EXISTS (SELECT 1 FROM public.report r
                                  WHERE r.uuid = rc.report_uuid
                                    AND r.timestamp > now() - interval '30 days'
                                    AND r.resolution IS DISTINCT FROM 'dismissed')
                ELSE rc.at < now() - interval '30 days'
           END;
    GET DIAGNOSTICS v_chat = ROW_COUNT;

    DELETE FROM public.invite_attempt WHERE created_at < now() - interval '1 hour';
    GET DIAGNOSTICS v_guesses = ROW_COUNT;

    DELETE FROM public.invite
     WHERE claimed_at IS NULL
       AND expires_at < now() - interval '90 days';
    GET DIAGNOSTICS v_links = ROW_COUNT;

    RETURN v_signups + v_logins + v_wealth + v_input + v_chat + v_guesses + v_links;
END; $$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- The helpers and the trigger function are granted to nobody. reap is
-- re-granted because it was replaced. Still no privilege of any kind on a
-- table: `select * from invite` as website is refused.

REVOKE ALL ON FUNCTION accounts.invite_maker_ok(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.invite_state(timestamptz, timestamptz, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.revoke_invites_on_ban() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.invite_preview(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.register_with_invite(text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.invite_create(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.invite_revoke(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.invites(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.citizen(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_set_invites(text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_invite_tree(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_inviters(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.reap() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.invite_preview(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.register_with_invite(text, text, text, text, text, text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.invite_create(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.invite_revoke(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.invites(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.citizen(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_set_invites(text, text, text, boolean) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_invite_tree(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_inviters(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.reap() TO website;

-- The gate itself. accounts.register stays defined - the rollback gives it
-- back - but the website can no longer make an account without a link.
REVOKE EXECUTE ON FUNCTION accounts.register(text, text, text, text, text, text, text) FROM website;

-- rollback:
--
-- Applied in one transaction. The invite tree goes with the table, so dump it
-- first if it matters (pg_dump -t invite). With the grant restored, the old
-- website's open registration works again.
--
-- DROP TRIGGER IF EXISTS account_ban_revokes_invites ON public.account;
-- DROP FUNCTION IF EXISTS accounts.revoke_invites_on_ban();
-- DROP FUNCTION IF EXISTS accounts.staff_inviters(text);
-- DROP FUNCTION IF EXISTS accounts.staff_invite_tree(text, text);
-- DROP FUNCTION IF EXISTS accounts.staff_set_invites(text, text, text, boolean);
-- DROP FUNCTION IF EXISTS accounts.citizen(text);
-- DROP FUNCTION IF EXISTS accounts.invites(text);
-- DROP FUNCTION IF EXISTS accounts.invite_revoke(text, text);
-- DROP FUNCTION IF EXISTS accounts.invite_create(text, text);
-- DROP FUNCTION IF EXISTS accounts.register_with_invite(text, text, text, text, text, text, text, text);
-- DROP FUNCTION IF EXISTS accounts.invite_preview(text, text);
-- DROP FUNCTION IF EXISTS accounts.invite_state(timestamptz, timestamptz, timestamptz, boolean);
-- DROP FUNCTION IF EXISTS accounts.invite_maker_ok(int);
-- DROP TABLE IF EXISTS "invite_attempt";
-- DROP TABLE IF EXISTS "invite";
-- ALTER TABLE "account" DROP COLUMN IF EXISTS "invites_enabled";
-- GRANT EXECUTE ON FUNCTION accounts.register(text, text, text, text, text, text, text) TO website;
--
-- -- migration 4's reaper, restored.
-- CREATE OR REPLACE FUNCTION accounts.reap() RETURNS bigint
-- LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
-- DECLARE v_signups bigint; v_logins bigint; v_wealth bigint; v_input bigint; v_chat bigint;
-- BEGIN
--     DELETE FROM public.signup_attempt WHERE created_at < now() - interval '24 hours';
--     GET DIAGNOSTICS v_signups = ROW_COUNT;
--     DELETE FROM public.login_attempt WHERE created_at < now() - interval '1 hour';
--     GET DIAGNOSTICS v_logins = ROW_COUNT;
--     DELETE FROM public.session_wealth WHERE timestamp < now() - interval '7 days';
--     GET DIAGNOSTICS v_wealth = ROW_COUNT;
--     DELETE FROM public.report_input ri
--      WHERE CASE WHEN EXISTS (SELECT 1 FROM public.report r WHERE r.uuid = ri.report_uuid)
--                 THEN NOT EXISTS (SELECT 1 FROM public.report r
--                                   WHERE r.uuid = ri.report_uuid
--                                     AND r.timestamp > now() - interval '30 days'
--                                     AND r.resolution IS DISTINCT FROM 'dismissed')
--                 ELSE ri.flushed_at < now() - interval '30 days'
--            END;
--     GET DIAGNOSTICS v_input = ROW_COUNT;
--     DELETE FROM public.report_chat rc
--      WHERE CASE WHEN EXISTS (SELECT 1 FROM public.report r WHERE r.uuid = rc.report_uuid)
--                 THEN NOT EXISTS (SELECT 1 FROM public.report r
--                                   WHERE r.uuid = rc.report_uuid
--                                     AND r.timestamp > now() - interval '30 days'
--                                     AND r.resolution IS DISTINCT FROM 'dismissed')
--                 ELSE rc.at < now() - interval '30 days'
--            END;
--     GET DIAGNOSTICS v_chat = ROW_COUNT;
--     RETURN v_signups + v_logins + v_wealth + v_input + v_chat;
-- END; $$;
-- REVOKE ALL ON FUNCTION accounts.reap() FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION accounts.reap() TO website;
