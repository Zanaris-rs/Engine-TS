-- 3_message_centre: the Message Centre, the staff inbox, and the in-game alert.
--
-- Same shape as 2_website_login. The website role still holds no privilege on
-- any table in public: everything below is SECURITY DEFINER with a pinned
-- search_path, REVOKEd from PUBLIC, and keyed by the username carried in the
-- signed session cookie (or, for the staff half, by an actor whose
-- staffmodlevel is re-read from the database on every call - never trusted
-- from the cookie).
--
-- One unread rule everywhere, and it is a cross-repo contract pinned in
-- engine/test/fixtures/message-centre-contract.json and copied into the
-- website's own fixture:
--
--     count(*) from account_message where account_id = $1 and read_at is null
--
-- The login server counts exactly that over Kysely and sends the number to the
-- client's welcome screen; accounts.unread() below counts exactly that after
-- resolving the username to an id. If the two ever disagree the player sees a
-- number in game that the site cannot explain, which is why it is written down
-- in three places rather than two.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

-- No foreign keys, matching every other table in this database, and RLS on
-- with no policies, matching 0_init: nothing reaches these rows except through
-- a SECURITY DEFINER function.

CREATE TABLE IF NOT EXISTS "account_message" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "ticket_id" INTEGER,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_account_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "account_message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ticket" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ticket_message" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "author_account_id" INTEGER NOT NULL,
    "from_staff" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "staff_action" (
    "id" SERIAL NOT NULL,
    "actor_account_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_action_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "account_message_account_id_read_at_idx" ON "account_message"("account_id", "read_at");
CREATE INDEX IF NOT EXISTS "account_message_account_id_created_at_idx" ON "account_message"("account_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ticket_account_id_updated_at_idx" ON "ticket"("account_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "ticket_status_updated_at_idx" ON "ticket"("status", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "ticket_message_ticket_id_created_at_idx" ON "ticket_message"("ticket_id", "created_at");

-- The rate limits below are counting scans, not lookups: ticket_reply counts a
-- player's own messages in the last hour and staff_notice counts one actor's
-- notices in the last hour, both on tables that only ever grow. And
-- staff_reports orders every report by timestamp.
CREATE INDEX IF NOT EXISTS "ticket_message_author_account_id_created_at_idx" ON "ticket_message"("author_account_id", "created_at");
CREATE INDEX IF NOT EXISTS "staff_action_actor_account_id_action_created_at_idx" ON "staff_action"("actor_account_id", "action", "created_at");
CREATE INDEX IF NOT EXISTS "report_timestamp_idx" ON "report"("timestamp" DESC);

ALTER TABLE "account_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_action" ENABLE ROW LEVEL SECURITY;

-- Report Abuse had nowhere to go: the packet went to the logger thread, and
-- the logger server is disabled on this fleet, so every report was dropped
-- while the player was told it had been received. The login server writes the
-- row now, and it knows who pressed the button and on which world. Nullable,
-- because rows written before this migration know neither.
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "reporter_account_id" INTEGER;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "world" INTEGER;

-- ---------------------------------------------------------------------------
-- internal helpers: NOT granted to website
-- ---------------------------------------------------------------------------

-- Every staff function re-reads this. The session cookie carries a username
-- and nothing else, so a forged or stale cookie cannot promote anyone, and a
-- demoted moderator loses the inbox on their next request.
CREATE OR REPLACE FUNCTION accounts.is_staff(p_actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT coalesce((SELECT a.staffmodlevel >= 2 FROM public.account a WHERE a.username = p_actor), false);
$$;

-- ---------------------------------------------------------------------------
-- the player's Message Centre
-- ---------------------------------------------------------------------------

-- The contract count, with the username resolved to an id first.
CREATE OR REPLACE FUNCTION accounts.unread(p_username text) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT count(*)::int
    FROM public.account_message m
    JOIN public.account a ON a.id = m.account_id
    WHERE a.username = p_username AND m.read_at IS NULL;
$$;

-- Unread first, then newest first. `preview` is the first 160 characters of
-- the body so the list page needs no second call.
CREATE OR REPLACE FUNCTION accounts.messages(p_username text)
RETURNS TABLE (id int, ticket_id int, kind text, subject text,
               created_at timestamptz, read_at timestamptz, preview text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.id, m.ticket_id, m.kind, m.subject, m.created_at, m.read_at, left(m.body, 160)
    FROM public.account_message m
    JOIN public.account a ON a.id = m.account_id
    WHERE a.username = p_username
    ORDER BY (m.read_at IS NULL) DESC, m.created_at DESC
    LIMIT 200;
$$;

-- Owner only, and reading it is what marks it read. read_at comes back as it
-- was *before* this call, so the page can still say "new" the one time it is.
CREATE OR REPLACE FUNCTION accounts.message(p_username text, p_id int)
RETURNS TABLE (id int, ticket_id int, kind text, subject text, body text,
               created_at timestamptz, read_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_account_id int;
BEGIN
    SELECT a.id INTO v_account_id FROM public.account a WHERE a.username = p_username;
    IF v_account_id IS NULL THEN RETURN; END IF;

    RETURN QUERY
        SELECT m.id, m.ticket_id, m.kind, m.subject, m.body, m.created_at, m.read_at
        FROM public.account_message m
        WHERE m.id = p_id AND m.account_id = v_account_id;

    UPDATE public.account_message m SET read_at = now()
     WHERE m.id = p_id AND m.account_id = v_account_id AND m.read_at IS NULL;
END; $$;

-- `unread` here is the ticket's own unread replies, which is the number the
-- list page puts next to the row.
CREATE OR REPLACE FUNCTION accounts.tickets(p_username text)
RETURNS TABLE (id int, kind text, subject text, status text,
               created_at timestamptz, updated_at timestamptz, unread int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.id, t.kind, t.subject, t.status, t.created_at, t.updated_at,
           (SELECT count(*)::int FROM public.account_message m
             WHERE m.ticket_id = t.id AND m.account_id = t.account_id AND m.read_at IS NULL)
    FROM public.ticket t
    JOIN public.account a ON a.id = t.account_id
    WHERE a.username = p_username
    ORDER BY t.updated_at DESC
    LIMIT 200;
$$;

-- One row per message with the ticket's own columns repeated, so the page
-- needs a single call: the caller reads the header off the first row. A LEFT
-- JOIN, so a ticket that somehow has no messages still identifies itself.
-- Opening the thread marks that ticket's `reply` notices read.
CREATE OR REPLACE FUNCTION accounts.ticket_thread(p_username text, p_ticket_id int)
RETURNS TABLE (ticket_id int, ticket_kind text, ticket_subject text, ticket_status text,
               ticket_created_at timestamptz, ticket_updated_at timestamptz,
               message_id int, from_staff boolean, author text, body text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_account_id int;
BEGIN
    SELECT a.id INTO v_account_id FROM public.account a WHERE a.username = p_username;
    IF v_account_id IS NULL THEN RETURN; END IF;

    IF NOT EXISTS (SELECT 1 FROM public.ticket t WHERE t.id = p_ticket_id AND t.account_id = v_account_id) THEN
        RETURN;
    END IF;

    RETURN QUERY
        SELECT t.id, t.kind, t.subject, t.status, t.created_at, t.updated_at,
               tm.id, tm.from_staff, coalesce(au.username, ''), tm.body, tm.created_at
        FROM public.ticket t
        LEFT JOIN public.ticket_message tm ON tm.ticket_id = t.id
        LEFT JOIN public.account au ON au.id = tm.author_account_id
        WHERE t.id = p_ticket_id
        ORDER BY tm.created_at, tm.id;

    UPDATE public.account_message m SET read_at = now()
     WHERE m.account_id = v_account_id AND m.ticket_id = p_ticket_id AND m.read_at IS NULL;
END; $$;

-- 'ok' | 'rate_limited' | 'invalid'. Five per account per day: a bug report is
-- not a chat window, and the staff inbox is read by people.
CREATE OR REPLACE FUNCTION accounts.ticket_open(p_username text, p_kind text, p_subject text, p_body text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_account_id int; v_today int; v_ticket_id int;
BEGIN
    SELECT a.id INTO v_account_id FROM public.account a WHERE a.username = p_username;
    IF v_account_id IS NULL THEN RETURN 'invalid'; END IF;

    IF p_kind NOT IN ('bug', 'appeal', 'other')
       OR p_subject IS NULL OR length(btrim(p_subject)) = 0 OR length(p_subject) > 120
       OR p_body IS NULL OR length(btrim(p_body)) = 0 OR length(p_body) > 4000 THEN
        RETURN 'invalid';
    END IF;

    SELECT count(*) INTO v_today FROM public.ticket t
     WHERE t.account_id = v_account_id AND t.created_at > now() - interval '1 day';
    IF v_today >= 5 THEN RETURN 'rate_limited'; END IF;

    INSERT INTO public.ticket (account_id, kind, subject)
    VALUES (v_account_id, p_kind, btrim(p_subject))
    RETURNING id INTO v_ticket_id;

    INSERT INTO public.ticket_message (ticket_id, author_account_id, from_staff, body)
    VALUES (v_ticket_id, v_account_id, false, btrim(p_body));

    RETURN 'ok';
END; $$;

-- 'ok' | 'not_found' | 'closed' | 'rate_limited' | 'invalid'. The cap is on
-- the player's own messages, so a staff reply never uses up the allowance.
CREATE OR REPLACE FUNCTION accounts.ticket_reply(p_username text, p_ticket_id int, p_body text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_account_id int; v_status text; v_recent int;
BEGIN
    SELECT a.id INTO v_account_id FROM public.account a WHERE a.username = p_username;
    IF v_account_id IS NULL THEN RETURN 'not_found'; END IF;

    IF p_body IS NULL OR length(btrim(p_body)) = 0 OR length(p_body) > 4000 THEN
        RETURN 'invalid';
    END IF;

    SELECT t.status INTO v_status FROM public.ticket t
     WHERE t.id = p_ticket_id AND t.account_id = v_account_id;
    IF v_status IS NULL THEN RETURN 'not_found'; END IF;
    IF v_status <> 'open' THEN RETURN 'closed'; END IF;

    SELECT count(*) INTO v_recent FROM public.ticket_message tm
     WHERE tm.author_account_id = v_account_id AND tm.from_staff = false
       AND tm.created_at > now() - interval '1 hour';
    IF v_recent >= 20 THEN RETURN 'rate_limited'; END IF;

    INSERT INTO public.ticket_message (ticket_id, author_account_id, from_staff, body)
    VALUES (p_ticket_id, v_account_id, false, btrim(p_body));

    UPDATE public.ticket SET updated_at = now() WHERE id = p_ticket_id;

    RETURN 'ok';
END; $$;

-- ---------------------------------------------------------------------------
-- the staff inbox
-- ---------------------------------------------------------------------------

-- `awaiting_staff` is true when the newest message on the ticket is the
-- player's, which is the only ordering staff actually want. p_status is
-- 'open' (the default), 'closed', or 'all' for no filter; anything else
-- matches no status and returns nothing.
CREATE OR REPLACE FUNCTION accounts.staff_inbox(p_actor text, p_status text DEFAULT 'open')
RETURNS TABLE (id int, username text, kind text, subject text, status text,
               created_at timestamptz, updated_at timestamptz, awaiting_staff boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.id, a.username, t.kind, t.subject, t.status, t.created_at, t.updated_at,
           NOT coalesce((SELECT tm.from_staff FROM public.ticket_message tm
                          WHERE tm.ticket_id = t.id
                          ORDER BY tm.created_at DESC, tm.id DESC LIMIT 1), false)
    FROM public.ticket t
    JOIN public.account a ON a.id = t.account_id
    WHERE accounts.is_staff(p_actor)
      AND (coalesce(p_status, 'open') = 'all' OR t.status = p_status)
    ORDER BY t.updated_at DESC
    LIMIT 200;
$$;

-- The same shape as ticket_thread plus the ticket owner's name, and it marks
-- nothing read: the unread flags belong to the player, not to staff.
CREATE OR REPLACE FUNCTION accounts.staff_thread(p_actor text, p_ticket_id int)
RETURNS TABLE (ticket_id int, username text, ticket_kind text, ticket_subject text, ticket_status text,
               ticket_created_at timestamptz, ticket_updated_at timestamptz,
               message_id int, from_staff boolean, author text, body text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.id, a.username, t.kind, t.subject, t.status, t.created_at, t.updated_at,
           tm.id, tm.from_staff, coalesce(au.username, ''), tm.body, tm.created_at
    FROM public.ticket t
    JOIN public.account a ON a.id = t.account_id
    LEFT JOIN public.ticket_message tm ON tm.ticket_id = t.id
    LEFT JOIN public.account au ON au.id = tm.author_account_id
    WHERE accounts.is_staff(p_actor) AND t.id = p_ticket_id
    ORDER BY tm.created_at, tm.id;
$$;

-- 'ok' | 'forbidden' | 'not_found' | 'closed' | 'invalid'. Two rows on success,
-- always: the thread message staff see, and the account_message that makes the
-- player's unread count go up - in game on their next login, on the site
-- immediately.
--
-- A closed ticket refuses a reply, the same way ticket_reply does for the
-- player, unless p_close is true: re-closing one, or having the last word on
-- the way out, is exactly the case where staff still need to write.
CREATE OR REPLACE FUNCTION accounts.staff_reply(p_actor text, p_ticket_id int, p_body text, p_close boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor_id int; v_owner_id int; v_subject text; v_status text;
BEGIN
    IF NOT accounts.is_staff(p_actor) THEN RETURN 'forbidden'; END IF;

    IF p_body IS NULL OR length(btrim(p_body)) = 0 OR length(p_body) > 4000 THEN
        RETURN 'invalid';
    END IF;

    SELECT a.id INTO v_actor_id FROM public.account a WHERE a.username = p_actor;

    SELECT t.account_id, t.subject, t.status INTO v_owner_id, v_subject, v_status
      FROM public.ticket t WHERE t.id = p_ticket_id;
    IF v_owner_id IS NULL THEN RETURN 'not_found'; END IF;
    IF v_status <> 'open' AND NOT coalesce(p_close, false) THEN RETURN 'closed'; END IF;

    INSERT INTO public.ticket_message (ticket_id, author_account_id, from_staff, body)
    VALUES (p_ticket_id, v_actor_id, true, btrim(p_body));

    INSERT INTO public.account_message (account_id, ticket_id, kind, subject, body, created_by_account_id)
    VALUES (v_owner_id, p_ticket_id, 'reply', left('Re: ' || v_subject, 120), btrim(p_body), v_actor_id);

    UPDATE public.ticket
       SET status = CASE WHEN coalesce(p_close, false) THEN 'closed' ELSE status END,
           updated_at = now()
     WHERE id = p_ticket_id;

    INSERT INTO public.staff_action (actor_account_id, action, target)
    VALUES (v_actor_id, CASE WHEN coalesce(p_close, false) THEN 'staff_reply_close' ELSE 'staff_reply' END,
            'ticket:' || p_ticket_id);

    RETURN 'ok';
END; $$;

-- 'ok' | 'forbidden' | 'bad_credentials' | 'rate_limited' | 'not_found' | 'invalid'.
--
-- The one verb in this API that writes into someone else's inbox in a staff
-- member's name, so it is the one that re-types a password: the site hashes
-- the typed password against the actor's own salt and this compares it, the
-- same CAS the account centre uses. A leaked `website` credential therefore
-- still cannot impersonate a moderator here, and every call that gets through
-- leaves a staff_action row behind.
CREATE OR REPLACE FUNCTION accounts.staff_notice(p_actor text, p_actor_candidate_hash text,
                                                 p_username text, p_subject text, p_body text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor_id int; v_password text; v_target_id int; v_hour int;
BEGIN
    IF NOT accounts.is_staff(p_actor) THEN RETURN 'forbidden'; END IF;

    -- The re-type rides the same limiter as website login (ten failures per
    -- name per fifteen minutes), but in a bucket of its own: keyed on the bare
    -- username, ten fat-fingered notices would also lock the moderator out of
    -- signing in, and losing your own account because you mistyped a password
    -- into a form you were already signed in to is absurd. There is no ip to
    -- pass either - the route calls this with the session's username only - so
    -- the prefixed name stands in for one as well, which keeps these failures
    -- out of every real address's bucket too.
    IF accounts.throttled('notice:' || p_actor, p_actor) THEN RETURN 'rate_limited'; END IF;

    SELECT a.id, a.password INTO v_actor_id, v_password FROM public.account a WHERE a.username = p_actor;

    IF p_actor_candidate_hash IS NULL OR length(p_actor_candidate_hash) <> 60
       OR v_password IS NULL OR v_password <> p_actor_candidate_hash THEN
        PERFORM accounts.record_failure('notice:' || p_actor, p_actor);
        RETURN 'bad_credentials';
    END IF;

    IF p_subject IS NULL OR length(btrim(p_subject)) = 0 OR length(p_subject) > 120
       OR p_body IS NULL OR length(btrim(p_body)) = 0 OR length(p_body) > 4000 THEN
        RETURN 'invalid';
    END IF;

    SELECT count(*) INTO v_hour FROM public.staff_action s
     WHERE s.actor_account_id = v_actor_id AND s.action = 'staff_notice'
       AND s.created_at > now() - interval '1 hour';
    IF v_hour >= 20 THEN RETURN 'rate_limited'; END IF;

    SELECT a.id INTO v_target_id FROM public.account a WHERE a.username = p_username;
    IF v_target_id IS NULL THEN RETURN 'not_found'; END IF;

    INSERT INTO public.account_message (account_id, kind, subject, body, created_by_account_id)
    VALUES (v_target_id, 'notice', btrim(p_subject), btrim(p_body), v_actor_id);

    INSERT INTO public.staff_action (actor_account_id, action, target)
    VALUES (v_actor_id, 'staff_notice', p_username);

    RETURN 'ok';
END; $$;

-- Report Abuse rows with both names resolved. p_since null means the last week.
CREATE OR REPLACE FUNCTION accounts.staff_reports(p_actor text, p_since timestamptz)
RETURNS TABLE (id int, reported_at timestamptz, world int, reporter text,
               offender text, reason int, coord int, session_uuid text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.id, r.timestamp, r.world, coalesce(reporter.username, ''),
           r.offender, r.reason, r.coord, r.session_uuid
    FROM public.report r
    LEFT JOIN public.account reporter ON reporter.id = r.reporter_account_id
    WHERE accounts.is_staff(p_actor)
      AND r.timestamp > coalesce(p_since, now() - interval '7 days')
    ORDER BY r.timestamp DESC
    LIMIT 500;
$$;

-- ---------------------------------------------------------------------------
-- accounts.register: a new account starts with one unread message
-- ---------------------------------------------------------------------------
--
-- Same signature, same seven parameters, same three return values, same caps
-- as 1_register_caps - the only change is the welcome notice at the end, which
-- is what makes a brand new player's first login say "1 unread message" on the
-- welcome screen and gives them somewhere to click. It is written in the same
-- transaction as the account row, so the two can never disagree.
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
    v_account_id int;
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

    IF v_ip_recent >= 3 OR v_ip_day >= 10 OR v_group_day >= 30 THEN
        RETURN 'rate_limited';
    END IF;

    IF EXISTS (SELECT 1 FROM public.account WHERE username = p_username) THEN
        RETURN 'username_taken';
    END IF;

    -- A nested block, so losing the race to the unique index between the check
    -- above and this insert rolls back only the insert. Nothing has been
    -- charged yet at this point, so that loser walks away owing nothing.
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
            RETURN 'username_taken';
    END;

    -- The account exists; charge the caps. Same transaction as the insert
    -- above, so the two rows can never disagree about what happened.
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

    RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER functions are EXECUTE-able by PUBLIC by default, so the
-- default comes off every one of them before anything is granted. is_staff is
-- deliberately granted to nobody: it is a helper the staff functions call
-- while running as the definer, not an API.

REVOKE ALL ON FUNCTION accounts.is_staff(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.unread(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.messages(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.message(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.tickets(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.ticket_thread(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.ticket_open(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.ticket_reply(text, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_inbox(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_thread(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_reply(text, int, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_notice(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_reports(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.register(text, text, text, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.unread(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.messages(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.message(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.tickets(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.ticket_thread(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.ticket_open(text, text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.ticket_reply(text, int, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_inbox(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_thread(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_reply(text, int, text, boolean) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_notice(text, text, text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_reports(text, timestamptz) TO website;
GRANT EXECUTE ON FUNCTION accounts.register(text, text, text, text, text, text, text) TO website;

-- Deliberately absent, still: any grant at all on schema public or the tables
-- in it. `select * from account_message` as website is refused; the twelve
-- functions above are the whole of what a leaked website credential can do.
