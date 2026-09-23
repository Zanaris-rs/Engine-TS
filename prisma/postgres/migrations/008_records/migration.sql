-- 8_records: timed XP records, started and stopped from the website.
--
-- A player signs in on the site, logs out of the game, presses Start, logs in
-- and plays, logs out before the timer runs out, and presses Stop. What they
-- gained is the difference between two hiscore snapshots, one taken at Start
-- and one at Stop, per skill and in total.
--
-- ## Why two offline snapshots are exact
--
-- Hiscores only move when a save reaches the login server: on logout, and on
-- the world-global fifteen-minute autosave. While a player is logged out
-- nothing can change their XP, so their hiscore rows are their XP exactly. Both
-- snapshots here are taken while the player is logged out, so neither can be
-- stale, and neither depends on when anybody clicks anything: the window is
-- `started_at` to the logout that preceded Stop, and the server wrote both.
--
-- The engine is untouched. Everything below reads tables the login server
-- already keeps: `account_login` (who is in the game, and when they last left
-- it cleanly), `session` (a row per login), `hiscore` and `hiscore_large`.
--
-- ## The rules, in one place
--
-- - Start and Stop both require the player to be logged out, **and settled**:
--   five seconds past `account_login.logout_time`. The login server writes
--   `logged_in = 0` first and runs `updateHiscores` after its reply to the
--   world, on purpose (LoginServer.ts, the player_logout branch), so for a
--   moment a player looks logged out while their hiscore still holds the
--   numbers from before that session. A Start in that moment would bank XP
--   earned before it. The upserts take milliseconds; five seconds is margin.
-- - The window ends at the **final logout**, the `logout_time` Stop finds.
--   `elapsed = final_logout_at - started_at`. Over the duration plus its grace
--   is rejected; ten seconds of grace covers the tick the world takes to act on
--   a logout, the hop to the login server, and combat's logout lock.
-- - Nobody is logged out for them. Logging out in time, and pressing Stop
--   before logging in again, is the player's job and the site says so up front.
-- - A session that began after the final clean logout, and so ended some other
--   way - a world crash, or a forced logout, which by design saves nothing - is
--   **void**: the save behind the hiscore is not one we can vouch for. Void is
--   our failure, not the player's, and does not count against their starts.
-- - One running attempt per account; twelve starts an hour, void ones free.
-- - An attempt nobody stopped reads as abandoned an hour after its window, and
--   is written as such the next time the player starts, stops or cancels.
--   There is no scheduler: nothing here needs one.
-- - Only `valid` attempts are public. Everything else is the player's own
--   history, kept so the site can tell them why.
-- - Staff above level 1 and banned accounts cannot start: `updateHiscores`
--   skips them, so their hiscore never moves and a record would read zero.
--
-- ## Categories are hiscore types
--
-- `record_attempt_skill.category` is the hiscore `type`: 0 is Overall, from
-- `hiscore_large`, and 1..21 are the skills, from `hiscore` - the stat id plus
-- one, the numbering the website's `CATEGORIES` already speaks. Nothing here
-- converts to stat ids, so nothing here can be off by one.
--
-- A skill under base level 15 has no hiscore row and so no entry; one that
-- crosses 15 during an attempt has no start and so no gain. Nobody is
-- competing on levels 1-15. Overall covers every enabled stat regardless.
--
-- ## Clocks
--
-- `started_at` is this database's `now()`, `logout_time` is the login
-- server's, and `session.timestamp` is the world's. All three are NTP-synced
-- machines; the skew is milliseconds against a grace of ten seconds and a
-- login that takes several.
--
-- No foreign keys, like every other table here. Nothing is ever deleted and
-- `accounts.reap()` is untouched: the attempts are the record book.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "record_attempt" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'running',
    "reason" TEXT,
    "initial_logout_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "final_logout_at" TIMESTAMPTZ(3),
    "stopped_at" TIMESTAMPTZ(3),
    "elapsed_ms" BIGINT,

    CONSTRAINT "record_attempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "record_attempt_state" CHECK ("state" IN ('running', 'valid', 'rejected', 'void', 'abandoned')),
    CONSTRAINT "record_attempt_reason" CHECK ("reason" IS NULL OR "reason" IN ('over_time', 'no_session', 'no_clean_logout', 'player', 'not_stopped')),
    CONSTRAINT "record_attempt_stopped" CHECK (("state" = 'running') = ("stopped_at" IS NULL)),
    CONSTRAINT "record_attempt_measured" CHECK (("final_logout_at" IS NULL) = ("elapsed_ms" IS NULL))
);

-- One row per hiscore category the player had at Start. `end_xp` and `gained`
-- are filled at Stop when the attempt had a final logout to measure against.
-- XP is raw, at the engine's x10 scale, like `hiscore.value`.
CREATE TABLE IF NOT EXISTS "record_attempt_skill" (
    "attempt_id" INTEGER NOT NULL,
    "category" INTEGER NOT NULL,
    "start_xp" BIGINT NOT NULL,
    "end_xp" BIGINT,
    "gained" BIGINT,

    CONSTRAINT "record_attempt_skill_pkey" PRIMARY KEY ("attempt_id", "category"),
    CONSTRAINT "record_attempt_skill_category" CHECK ("category" BETWEEN 0 AND 21),
    CONSTRAINT "record_attempt_skill_gained" CHECK ("gained" IS NULL OR "gained" = "end_xp" - "start_xp")
);

-- The database's own guarantee of one running attempt per account: two tabs
-- pressing Start at once cannot both insert, whatever the function does.
-- Postgres only - Prisma has no way to say "partial", and nothing on sqlite or
-- mysql runs these functions.
CREATE UNIQUE INDEX IF NOT EXISTS "record_attempt_one_running_key" ON "record_attempt"("account_id") WHERE "state" = 'running';
CREATE INDEX IF NOT EXISTS "record_attempt_account_id_started_at_idx" ON "record_attempt"("account_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "record_attempt_profile_duration_seconds_state_idx" ON "record_attempt"("profile", "duration_seconds", "state");
CREATE INDEX IF NOT EXISTS "record_attempt_skill_category_gained_idx" ON "record_attempt_skill"("category", "gained" DESC);

ALTER TABLE "record_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "record_attempt_skill" ENABLE ROW LEVEL SECURITY;

-- === functions ===

-- ---------------------------------------------------------------------------
-- internal helpers: NOT granted to website
-- ---------------------------------------------------------------------------

-- 'logged_in' | 'syncing' | 'logged_out' | 'never'.
--
-- Where the player is, as far as a snapshot is concerned. 'syncing' is logged
-- out less than five seconds ago, when the hiscore write that follows a logout
-- may not have landed yet. 'never' is no clean logout on record at all - a new
-- account, or one whose every session ended in a crash - and so no hiscore
-- this function can vouch for.
CREATE OR REPLACE FUNCTION accounts.record_presence(p_logged_in int, p_logout_time timestamptz) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE
        WHEN coalesce(p_logged_in, 0) <> 0 THEN 'logged_in'
        WHEN p_logout_time IS NULL THEN 'never'
        WHEN p_logout_time > now() - interval '5 seconds' THEN 'syncing'
        ELSE 'logged_out'
    END;
$$;

-- A running attempt nobody stopped within an hour of its window. The reads
-- show it as abandoned from that moment; the writes below store it as such.
CREATE OR REPLACE FUNCTION accounts.record_stale(p_state text, p_started_at timestamptz, p_duration_seconds int) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p_state = 'running'
       AND now() > p_started_at + make_interval(secs => p_duration_seconds) + interval '1 hour';
$$;

-- Store the account's stale running attempt, if it has one, as abandoned. Its
-- `stopped_at` is the cutoff rather than now(), so the row reads the same
-- whenever it happened to be written.
CREATE OR REPLACE FUNCTION accounts.record_close_stale(p_account_id int) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE public.record_attempt ra
       SET state = 'abandoned',
           reason = 'not_stopped',
           stopped_at = ra.started_at + make_interval(secs => ra.duration_seconds) + interval '1 hour'
     WHERE ra.account_id = p_account_id
       AND accounts.record_stale(ra.state, ra.started_at, ra.duration_seconds);
$$;

-- ---------------------------------------------------------------------------
-- the rules the site shows
-- ---------------------------------------------------------------------------

-- Every duration a record can be, and the grace after it. One row today; six
-- hours and a day are one line each later. The site owns the labels and
-- db:check asserts the two agree.
CREATE OR REPLACE FUNCTION accounts.record_durations()
RETURNS TABLE (duration_seconds int, grace_seconds int)
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    VALUES (300, 10);
$$;

-- ---------------------------------------------------------------------------
-- start, stop, cancel
-- ---------------------------------------------------------------------------

-- 'ok' | 'not_found' | 'unknown_duration' | 'staff' | 'banned'
-- | 'already_running' | 'logged_in' | 'syncing' | 'no_hiscore' | 'too_many'.
--
-- The name is resolved before anything else, so an unknown one writes
-- nothing: db:check calls this against a name nobody has.
CREATE OR REPLACE FUNCTION accounts.record_start(p_username text, p_duration_seconds int)
RETURNS TABLE (result text, attempt_id int, started_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_profile text := accounts.public_profile();
    v_account_id int;
    v_staffmodlevel int;
    v_banned_until timestamptz;
    v_logged_in int;
    v_logout_time timestamptz;
    v_presence text;
    v_recent int;
    v_id int;
    v_started_at timestamptz;
BEGIN
    SELECT a.id, a.staffmodlevel, a.banned_until
      INTO v_account_id, v_staffmodlevel, v_banned_until
      FROM public.account a
     WHERE a.username = p_username;

    IF v_account_id IS NULL THEN
        RETURN QUERY SELECT 'not_found'::text, NULL::int, NULL::timestamptz;
        RETURN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM accounts.record_durations() d WHERE d.duration_seconds = p_duration_seconds) THEN
        RETURN QUERY SELECT 'unknown_duration'::text, NULL::int, NULL::timestamptz;
        RETURN;
    END IF;

    IF v_staffmodlevel > 1 THEN
        RETURN QUERY SELECT 'staff'::text, NULL::int, NULL::timestamptz;
        RETURN;
    END IF;

    IF v_banned_until IS NOT NULL AND v_banned_until > now() THEN
        RETURN QUERY SELECT 'banned'::text, NULL::int, NULL::timestamptz;
        RETURN;
    END IF;

    -- Two tabs pressing Start at once must not both get under the cap.
    PERFORM pg_advisory_xact_lock(hashtext('record:' || v_account_id));
    PERFORM accounts.record_close_stale(v_account_id);

    IF EXISTS (SELECT 1 FROM public.record_attempt ra WHERE ra.account_id = v_account_id AND ra.state = 'running') THEN
        RETURN QUERY SELECT 'already_running'::text, NULL::int, NULL::timestamptz;
        RETURN;
    END IF;

    SELECT l.logged_in, l.logout_time
      INTO v_logged_in, v_logout_time
      FROM public.account_login l
     WHERE l.account_id = v_account_id
       AND l.profile = v_profile;

    v_presence := accounts.record_presence(v_logged_in, v_logout_time);

    IF v_presence = 'logged_in' OR v_presence = 'syncing' THEN
        RETURN QUERY SELECT v_presence, NULL::int, NULL::timestamptz;
        RETURN;
    END IF;

    IF v_presence = 'never' OR NOT EXISTS (
        SELECT 1 FROM public.hiscore_large h
         WHERE h.account_id = v_account_id AND h.profile = v_profile AND h.type = 0
    ) THEN
        RETURN QUERY SELECT 'no_hiscore'::text, NULL::int, NULL::timestamptz;
        RETURN;
    END IF;

    -- Counted off this table's own rows, because the site has no rate limiter
    -- of its own. A void attempt was our failure, so it is free.
    SELECT count(*) INTO v_recent
      FROM public.record_attempt ra
     WHERE ra.account_id = v_account_id
       AND ra.started_at > now() - interval '1 hour'
       AND ra.state <> 'void';

    IF v_recent >= 12 THEN
        RETURN QUERY SELECT 'too_many'::text, NULL::int, NULL::timestamptz;
        RETURN;
    END IF;

    BEGIN
        INSERT INTO public.record_attempt (account_id, profile, duration_seconds, initial_logout_at)
        VALUES (v_account_id, v_profile, p_duration_seconds, v_logout_time)
        RETURNING id, started_at INTO v_id, v_started_at;
    EXCEPTION
        WHEN unique_violation THEN
            RETURN QUERY SELECT 'already_running'::text, NULL::int, NULL::timestamptz;
            RETURN;
    END;

    INSERT INTO public.record_attempt_skill (attempt_id, category, start_xp)
    SELECT v_id, h.type, h.value
      FROM public.hiscore_large h
     WHERE h.account_id = v_account_id AND h.profile = v_profile AND h.type = 0
    UNION ALL
    SELECT v_id, h.type, h.value
      FROM public.hiscore h
     WHERE h.account_id = v_account_id AND h.profile = v_profile;

    RETURN QUERY SELECT 'ok'::text, v_id, v_started_at;
END; $$;

-- 'ok' | 'not_found' | 'not_running' | 'logged_in' | 'syncing'.
--
-- On 'ok' the attempt is closed and `state`/`reason` say how:
--
--   void      no_clean_logout  a session began after the final clean logout
--                              and ended some other way; checked first, so a
--                              window we cannot vouch for is never reported
--                              as the player's fault
--   rejected  no_session       no clean logout since Start: they never played
--   rejected  over_time        final logout past the duration plus its grace
--   valid                      everything else
--   abandoned not_stopped      Stop came more than an hour after the window
--
-- The end snapshot is taken for valid and over_time, so the player is shown
-- what they gained either way. Only valid is ever public.
CREATE OR REPLACE FUNCTION accounts.record_stop(p_username text)
RETURNS TABLE (result text, attempt_id int, state text, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_profile text := accounts.public_profile();
    v_account_id int;
    v_id int;
    v_started_at timestamptz;
    v_duration int;
    v_grace int;
    v_logged_in int;
    v_logout_time timestamptz;
    v_presence text;
    v_elapsed bigint;
    v_state text;
    v_reason text;
BEGIN
    SELECT a.id INTO v_account_id FROM public.account a WHERE a.username = p_username;

    IF v_account_id IS NULL THEN
        RETURN QUERY SELECT 'not_found'::text, NULL::int, NULL::text, NULL::text;
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('record:' || v_account_id));

    SELECT ra.id, ra.started_at, ra.duration_seconds
      INTO v_id, v_started_at, v_duration
      FROM public.record_attempt ra
     WHERE ra.account_id = v_account_id
       AND ra.state = 'running'
       FOR UPDATE;

    IF v_id IS NULL THEN
        RETURN QUERY SELECT 'not_running'::text, NULL::int, NULL::text, NULL::text;
        RETURN;
    END IF;

    IF accounts.record_stale('running', v_started_at, v_duration) THEN
        PERFORM accounts.record_close_stale(v_account_id);
        RETURN QUERY SELECT 'ok'::text, v_id, 'abandoned'::text, 'not_stopped'::text;
        RETURN;
    END IF;

    SELECT l.logged_in, l.logout_time
      INTO v_logged_in, v_logout_time
      FROM public.account_login l
     WHERE l.account_id = v_account_id
       AND l.profile = v_profile;

    v_presence := accounts.record_presence(v_logged_in, v_logout_time);

    IF v_presence = 'logged_in' OR v_presence = 'syncing' THEN
        RETURN QUERY SELECT v_presence, v_id, 'running'::text, NULL::text;
        RETURN;
    END IF;

    -- A login after both Start and the last clean logout, with the player now
    -- out of the game, is a session that ended without a clean logout. The
    -- hiscore behind it is whatever the last autosave left, which could be
    -- inside the window or long after it.
    IF EXISTS (
        SELECT 1 FROM public.session s
         WHERE s.account_id = v_account_id
           AND s.profile = v_profile
           AND s.timestamp > greatest(coalesce(v_logout_time, v_started_at), v_started_at)
    ) THEN
        v_state := 'void';
        v_reason := 'no_clean_logout';
    ELSIF v_logout_time IS NULL OR v_logout_time <= v_started_at THEN
        v_state := 'rejected';
        v_reason := 'no_session';
    ELSE
        v_elapsed := floor(extract(epoch FROM (v_logout_time - v_started_at)) * 1000)::bigint;

        UPDATE public.record_attempt_skill s
           SET end_xp = e.value,
               gained = e.value - s.start_xp
          FROM (SELECT h.type, h.value::bigint AS value
                  FROM public.hiscore_large h
                 WHERE h.account_id = v_account_id AND h.profile = v_profile AND h.type = 0
                UNION ALL
                SELECT h.type, h.value::bigint
                  FROM public.hiscore h
                 WHERE h.account_id = v_account_id AND h.profile = v_profile) e
         WHERE s.attempt_id = v_id
           AND s.category = e.type;

        SELECT d.grace_seconds INTO v_grace FROM accounts.record_durations() d WHERE d.duration_seconds = v_duration;

        IF v_elapsed > (v_duration + coalesce(v_grace, 0))::bigint * 1000 THEN
            v_state := 'rejected';
            v_reason := 'over_time';
        ELSE
            v_state := 'valid';
            v_reason := NULL;
        END IF;
    END IF;

    UPDATE public.record_attempt ra
       SET state = v_state,
           reason = v_reason,
           final_logout_at = CASE WHEN v_elapsed IS NULL THEN NULL ELSE v_logout_time END,
           elapsed_ms = v_elapsed,
           stopped_at = now()
     WHERE ra.id = v_id;

    RETURN QUERY SELECT 'ok'::text, v_id, v_state, v_reason;
END; $$;

-- 'ok' | 'not_found' | 'not_running'. The player giving up on their running
-- attempt. It still counts against their starts: the cap is on starting.
CREATE OR REPLACE FUNCTION accounts.record_abandon(p_username text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_account_id int;
    v_rows int;
BEGIN
    SELECT a.id INTO v_account_id FROM public.account a WHERE a.username = p_username;
    IF v_account_id IS NULL THEN RETURN 'not_found'; END IF;

    PERFORM pg_advisory_xact_lock(hashtext('record:' || v_account_id));
    PERFORM accounts.record_close_stale(v_account_id);

    UPDATE public.record_attempt ra
       SET state = 'abandoned', reason = 'player', stopped_at = now()
     WHERE ra.account_id = v_account_id
       AND ra.state = 'running';
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    RETURN CASE WHEN v_rows = 0 THEN 'not_running' ELSE 'ok' END;
END; $$;

-- ---------------------------------------------------------------------------
-- the player's own reads
-- ---------------------------------------------------------------------------

-- Exactly one row, always - for a player with no attempt, for a name nobody
-- has, and while an attempt runs. The account page polls this, and "no rows"
-- would be indistinguishable from "the read failed" by the time it reached the
-- page: one means "you have no attempt", the other "we lost your attempt".
-- So, as with public_staff_spawn_total: **do not add a GROUP BY**, and keep
-- the (SELECT 1) the laterals hang off.
--
-- The attempt is the newest one, running or not, so the page can show the
-- result of the one just stopped. Newest by id, the order they were inserted
-- in, rather than by started_at: the two agree in practice, but only the id
-- cannot be moved - and a running attempt is always the last one inserted,
-- because one must close before the next can start. `board_rank` is where a valid attempt's
-- Overall gain sits on its board right now: one more than the number of other
-- players whose best valid Overall gain beats it.
CREATE OR REPLACE FUNCTION accounts.record_current(p_username text)
RETURNS TABLE (presence text, logout_time timestamptz, server_now timestamptz,
               attempt_id int, state text, reason text, duration_seconds int, grace_seconds int,
               started_at timestamptz, final_logout_at timestamptz, stopped_at timestamptz,
               elapsed_ms bigint, gained bigint, board_rank int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT accounts.record_presence(l.logged_in, l.logout_time),
           l.logout_time,
           now(),
           ra.id,
           CASE WHEN accounts.record_stale(ra.state, ra.started_at, ra.duration_seconds) THEN 'abandoned' ELSE ra.state END,
           CASE WHEN accounts.record_stale(ra.state, ra.started_at, ra.duration_seconds) THEN 'not_stopped' ELSE ra.reason END,
           ra.duration_seconds,
           d.grace_seconds,
           ra.started_at,
           ra.final_logout_at,
           ra.stopped_at,
           ra.elapsed_ms,
           o.gained,
           CASE WHEN ra.state = 'valid' AND o.gained > 0 THEN
               1 + (SELECT count(DISTINCT other.account_id)::int
                      FROM public.record_attempt other
                      JOIN public.record_attempt_skill os ON os.attempt_id = other.id AND os.category = 0
                      JOIN public.account oa ON oa.id = other.account_id
                     WHERE other.state = 'valid'
                       AND other.profile = ra.profile
                       AND other.duration_seconds = ra.duration_seconds
                       AND other.account_id <> ra.account_id
                       AND os.gained > o.gained
                       AND oa.staffmodlevel <= 1
                       AND (oa.banned_until IS NULL OR oa.banned_until < now()))
           END
    FROM (SELECT 1) one
    LEFT JOIN public.account a ON a.username = p_username
    LEFT JOIN public.account_login l ON l.account_id = a.id AND l.profile = accounts.public_profile()
    LEFT JOIN LATERAL (
        SELECT r.* FROM public.record_attempt r
         WHERE r.account_id = a.id
         ORDER BY r.id DESC
         LIMIT 1
    ) ra ON true
    LEFT JOIN public.record_attempt_skill o ON o.attempt_id = ra.id AND o.category = 0
    LEFT JOIN accounts.record_durations() d ON d.duration_seconds = ra.duration_seconds;
$$;

-- The player's attempts, newest first, rejected and void ones included - that
-- is what they are kept for.
CREATE OR REPLACE FUNCTION accounts.record_history(p_username text, p_limit int)
RETURNS TABLE (attempt_id int, state text, reason text, duration_seconds int,
               started_at timestamptz, elapsed_ms bigint, gained bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT ra.id,
           CASE WHEN accounts.record_stale(ra.state, ra.started_at, ra.duration_seconds) THEN 'abandoned' ELSE ra.state END,
           CASE WHEN accounts.record_stale(ra.state, ra.started_at, ra.duration_seconds) THEN 'not_stopped' ELSE ra.reason END,
           ra.duration_seconds,
           ra.started_at,
           ra.elapsed_ms,
           o.gained
    FROM public.account a
    JOIN public.record_attempt ra ON ra.account_id = a.id
    LEFT JOIN public.record_attempt_skill o ON o.attempt_id = ra.id AND o.category = 0
    WHERE a.username = p_username
    ORDER BY ra.id DESC
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- One of the player's own attempts, skill by skill. Somebody else's id and an
-- id that does not exist both answer with no rows.
CREATE OR REPLACE FUNCTION accounts.record_attempt_skills(p_username text, p_attempt_id int)
RETURNS TABLE (category int, start_xp bigint, end_xp bigint, gained bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT s.category, s.start_xp, s.end_xp, s.gained
    FROM public.account a
    JOIN public.record_attempt ra ON ra.account_id = a.id
    JOIN public.record_attempt_skill s ON s.attempt_id = ra.id
    WHERE a.username = p_username
      AND ra.id = p_attempt_id
    ORDER BY s.category;
$$;

-- ---------------------------------------------------------------------------
-- the public board
-- ---------------------------------------------------------------------------

-- Each player's best valid attempt for one duration and one category, best
-- first; the earlier finish wins a tie. `state = 'valid'` is the one clause
-- that decides what is public - test/RecordsSql.test.ts pins it.
--
-- Banned accounts and staff above level 1 are left out, the hiscore views'
-- rule restated rather than borrowed, so the two pages agree about who exists
-- without either depending on the other. The profile is
-- `accounts.public_profile()`, not an argument, for the reason migration 4
-- gives: the caller must not choose what is public.
CREATE OR REPLACE FUNCTION accounts.record_board(p_duration_seconds int, p_category int, p_limit int)
RETURNS TABLE (rank int, username text, gained bigint, elapsed_ms bigint, achieved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT (row_number() OVER (ORDER BY best.gained DESC, best.achieved_at ASC, best.attempt_id ASC))::int,
           best.username, best.gained, best.elapsed_ms, best.achieved_at
    FROM (
        SELECT DISTINCT ON (ra.account_id)
               ra.id AS attempt_id, a.username, s.gained, ra.elapsed_ms, ra.final_logout_at AS achieved_at
          FROM public.record_attempt ra
          JOIN public.record_attempt_skill s ON s.attempt_id = ra.id
          JOIN public.account a ON a.id = ra.account_id
         WHERE ra.state = 'valid'
           AND ra.profile = accounts.public_profile()
           AND ra.duration_seconds = p_duration_seconds
           AND s.category = p_category
           AND s.gained > 0
           AND a.staffmodlevel <= 1
           AND (a.banned_until IS NULL OR a.banned_until < now())
         ORDER BY ra.account_id, s.gained DESC, ra.final_logout_at ASC, ra.id ASC
    ) best
    ORDER BY best.gained DESC, best.achieved_at ASC, best.attempt_id ASC
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Eight functions on the `website` role, taking it to fifty-two, and still no
-- privilege of any kind on schema public: `select * from record_attempt` as
-- website is refused. The three helpers are granted to nobody.

REVOKE ALL ON FUNCTION accounts.record_presence(int, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_stale(text, timestamptz, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_close_stale(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_durations() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_start(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_stop(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_abandon(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_current(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_history(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_attempt_skills(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_board(int, int, int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.record_durations() TO website;
GRANT EXECUTE ON FUNCTION accounts.record_start(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.record_stop(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.record_abandon(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.record_current(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.record_history(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.record_attempt_skills(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.record_board(int, int, int) TO website;

-- rollback:
--
-- Drops everything this migration made, rows included. Nothing else reads
-- these tables, so the site's /records pages answer "unavailable" and nothing
-- else changes. The attempts are gone for good: take a dump first.
--
-- DROP FUNCTION IF EXISTS accounts.record_board(int, int, int);
-- DROP FUNCTION IF EXISTS accounts.record_attempt_skills(text, int);
-- DROP FUNCTION IF EXISTS accounts.record_history(text, int);
-- DROP FUNCTION IF EXISTS accounts.record_current(text);
-- DROP FUNCTION IF EXISTS accounts.record_abandon(text);
-- DROP FUNCTION IF EXISTS accounts.record_stop(text);
-- DROP FUNCTION IF EXISTS accounts.record_start(text, int);
-- DROP FUNCTION IF EXISTS accounts.record_durations();
-- DROP FUNCTION IF EXISTS accounts.record_close_stale(int);
-- DROP FUNCTION IF EXISTS accounts.record_stale(text, timestamptz, int);
-- DROP FUNCTION IF EXISTS accounts.record_presence(int, timestamptz);
-- DROP TABLE IF EXISTS "record_attempt_skill";
-- DROP TABLE IF EXISTS "record_attempt";
