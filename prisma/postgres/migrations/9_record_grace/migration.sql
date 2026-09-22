-- 9_record_grace: the grace after a timed record is two seconds, not ten.
--
-- The owner cut it to two seconds on 2026-09-22. Migration 8 set ten, and said
-- what the ten covered: "the tick the world takes to act on a logout, the hop
-- to the login server, and combat's logout lock".
--
-- Two seconds still covers the first two. The world acts on a logout within
-- its 600ms tick, and the login server writes `account_login.logout_time` -
-- the final logout Stop measures to - one hop after that. It no longer covers
-- combat's logout lock, which keeps a player in the game for sixteen ticks,
-- just under ten seconds, after they are last attacked. Getting out of combat
-- in time to log out before 0:00 is now the player's job, as logging out at
-- all always was, and the site says so up front: "YOU must log out before the
-- timer reaches 0:00".
--
-- Clocks do not change the arithmetic. `started_at` is this database's
-- `now()` and `logout_time` is the login server's, both NTP-synced machines,
-- and the skew between them is milliseconds against two seconds.
--
-- ## What changes, and when
--
-- One line: `accounts.record_durations()` answers (300, 2) where it answered
-- (300, 10). It is the only place the grace lives. `record_stop` reads it at
-- Stop time - `SELECT d.grace_seconds INTO v_grace FROM
-- accounts.record_durations() d ...` - and `record_current` LEFT JOINs it for
-- the page, and neither is redefined here. So an attempt already running when
-- this is applied is judged by two seconds when it is stopped, not by the ten
-- it started under.
--
-- An attempt already stopped keeps its verdict: `state` and `reason` were
-- written at Stop, and nothing here touches them, so a valid attempt judged
-- under ten seconds stays valid and stays on the board. `record_current` takes
-- the grace it reports from the same join, so for the newest such attempt it
-- reports two seconds, not the ten that attempt was judged by.
--
-- ## What does not change
--
-- No table and no row. `CREATE OR REPLACE` keeps the function's owner and its
-- grants, and the signature, return type and attributes below are migration
-- 8's character for character, so it replaces the body and nothing else. The
-- return type has to match anyway: `CREATE OR REPLACE` cannot change one, and
-- would refuse at the prompt rather than drop anything. The REVOKE and GRANT
-- are migration 8's too, restated so this file says on its own who may call
-- what; both are idempotent, and the `website` role stays at fifty-two
-- functions.
--
-- The website's `lib/records/durations.ts` must say the same grace, and the
-- website's `npm run db:check` asserts that the two agree.

-- ---------------------------------------------------------------------------
-- the rules the site shows
-- ---------------------------------------------------------------------------

-- Every duration a record can be, and the grace after it. Five minutes, and
-- two seconds past them - enough for the world's tick and the login server's
-- write of the logout, and nothing for a player still in combat at 0:00.
CREATE OR REPLACE FUNCTION accounts.record_durations()
RETURNS TABLE (duration_seconds int, grace_seconds int)
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    VALUES (300, 2);
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Unchanged from migration 8, and restated rather than assumed.

REVOKE ALL ON FUNCTION accounts.record_durations() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.record_durations() TO website;

-- rollback:
--
-- Puts migration 8's ten seconds back. Nothing else was changed, so nothing
-- else needs undoing; attempts stopped under two seconds keep their verdicts,
-- as the ones stopped under ten did here. The website's
-- `lib/records/durations.ts` goes back to ten in the same breath, or db:check
-- says the two disagree.
--
-- CREATE OR REPLACE FUNCTION accounts.record_durations()
-- RETURNS TABLE (duration_seconds int, grace_seconds int)
-- LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
--     VALUES (300, 10);
-- $$;
