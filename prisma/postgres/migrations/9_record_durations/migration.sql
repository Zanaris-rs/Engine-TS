-- 9_record_durations: records can be six hours and a day, as well as five minutes.
--
-- The owner asked for longer records on 2026-09-22: five minutes, six hours
-- and twenty-four hours, all started and stopped from the website exactly as
-- migration 8 describes. Five minutes stays, and stays public - it is the one
-- short enough to test the whole flow with, and there is no reason to hide it
-- from players who want it.
--
-- ## What changes
--
-- One function. `accounts.record_durations()` answers three rows where it
-- answered one, and every rule migration 8 wrote reads the duration from that
-- row rather than carrying five minutes of its own:
--
--   - `record_start` refuses a duration this list does not have
--     ('unknown_duration'), so this file is what makes 21600 and 86400 legal.
--   - `record_stop` reads the grace here at Stop time, and rejects an attempt
--     whose final logout landed past `duration + grace` ('over_time').
--   - `record_stale` gives an attempt an hour past **its own** window before it
--     reads as abandoned, so a day-long attempt gets a day and an hour.
--   - `record_board` and `record_current` are already keyed by
--     `duration_seconds`: three durations are three boards, with no row of
--     either one's SQL changed.
--
-- No table, no row, no new function, and nothing to backfill. The attempts
-- already stopped are all five-minute ones and keep their verdicts.
--
-- ## The grace is ten seconds for all three
--
-- It covers the tick the world takes to act on a logout, the hop to the login
-- server that writes `account_login.logout_time`, and combat's logout lock
-- (sixteen ticks, just under ten seconds). That is the same ten seconds
-- migration 8 gave five minutes, for the same three reasons, and against six
-- hours or a day it is noise. Migration `9_record_grace` would have cut it to
-- two; the owner closed it unapplied on 2026-09-22, and the website is back at
-- ten (Website#14), so ten is what both sides say.
--
-- **That branch is the one hazard here.** `9_record_grace` replaces this same
-- function and is numbered 9 as well. If it is ever revived it must be
-- renumbered and rebuilt on top of this file - a `CREATE OR REPLACE` answering
-- `(300, 2)` applied after this one would take six hours and a day away again,
-- with nothing to say it had. `test/RecordDurationsSql.test.ts` fails if two
-- migration directories ever share a number.
--
-- ## What a longer window means for a player
--
-- Nothing in the rules changes, but two of them are worth saying out loud now
-- that a window can be a day long, because the site has to say them:
--
--   - They may log in and out as often as they like inside the window. Stop
--     measures `started_at` to the **final** logout, and a session that ended
--     cleanly and was followed by another is not an unclean end.
--   - One running attempt per account, which is `record_attempt_one_running_key`
--     and not something this file loosens. A player part-way through a
--     twenty-four hour attempt cannot start a five-minute one beside it; they
--     cancel it or stop it first. Deliberate: the attempts share one final
--     logout, so two running at once would be measuring the same session twice.
--
-- The website's `lib/records/durations.ts` owns the words for these three, and
-- its `npm run db:check` asserts the two lists agree - a duration added here
-- and not there is a board nobody can reach, and one added there and not here
-- is a button the database refuses.

-- ---------------------------------------------------------------------------
-- the rules the site shows
-- ---------------------------------------------------------------------------

-- Every duration a record can be, and the grace after it. Five minutes, six
-- hours and twenty-four hours; ten seconds past each, which is the world's
-- tick, the login server's write of the logout, and combat's logout lock.
--
-- The header below is migration 8's character for character - `CREATE OR
-- REPLACE` cannot change a return type, and a different argument list would
-- leave two functions with the grant on one.
CREATE OR REPLACE FUNCTION accounts.record_durations()
RETURNS TABLE (duration_seconds int, grace_seconds int)
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    VALUES (300, 10), (21600, 10), (86400, 10);
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Unchanged from migration 8, and restated rather than assumed. No function is
-- added here, so the `website` role stays at fifty-two.

REVOKE ALL ON FUNCTION accounts.record_durations() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.record_durations() TO website;

-- rollback:
--
-- Puts migration 8's one row back. A five-minute attempt is unaffected either
-- way; a six-hour or day-long attempt still running when this is rolled back
-- keeps its `duration_seconds` and is still stopped by `record_stop`, but with
-- no grace row to join it is judged by `coalesce(v_grace, 0)` - the window
-- exactly, no grace - and `record_current` reports its grace as null. Stop the
-- long attempts, or leave the row in, before rolling this back in anger.
--
-- The website's `lib/records/durations.ts` goes back to five minutes alone in
-- the same breath, or db:check says the two disagree.
--
-- CREATE OR REPLACE FUNCTION accounts.record_durations()
-- RETURNS TABLE (duration_seconds int, grace_seconds int)
-- LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
--     VALUES (300, 10);
-- $$;
