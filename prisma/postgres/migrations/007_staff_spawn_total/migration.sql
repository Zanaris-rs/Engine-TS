-- 7_staff_spawn_total: how many items staff have ever made, without a window.
--
-- /economy is being rebuilt around one sentence - "0 items ever created by
-- staff" - and migration 4 gave it no honest way to say it.
-- `accounts.public_staff_spawns(p_days)` clamps its argument to 1..90 days and
-- stops at 500 rows, and it does both silently: a caller asking for everything
-- is given ninety days, a caller counting the answer is given at most five
-- hundred, and neither is told which happened. A page rendering "ever" from
-- that read would be printing a claim it had not checked, on the one page
-- whose whole purpose is being checkable from outside the server.
--
-- This migration adds no table and changes no row. It adds two read functions
-- with no argument, no clamp and no ceiling, under the same rules as
-- everything else in `accounts`: SECURITY DEFINER over a table the `website`
-- role has no grant on, and REVOKE before GRANT.
--
--   public_staff_spawn_total  one row: how many spawns, how many items, and
--                             when the first and the last of them happened.
--   public_staff_spawns_all   every row, newest first, the same four columns
--                             the windowed read returns.
--
-- ## Why a whole-table read is the right shape here and nowhere else
--
-- Every other public read in this schema is windowed because the table behind
-- it grows with play: a census every hour, a row per ban, a wealth event per
-- trade. `staff_spawn` does not. Only an item-creating cheat writes to it -
-- ::give, ::givecrap, ::givemany, ::giveother - and `World.notifyStaffSpawn`
-- drops the row before it leaves the world process unless the world is a
-- production one, the moderator resolved to a real account, and `invAdd`
-- actually took something. On a well-run server the correct number of rows
-- here is zero, and it stays zero for months at a time.
--
-- So the bound every other function needs is the one bound this function
-- cannot have. "Ever" is the question being asked; a window is a different
-- question wearing the same words.
--
-- ## This table is never reaped, and has to stay that way
--
-- `accounts.reap()` has never deleted from `staff_spawn` - not in migration 4
-- where it was written, not in migration 6 where it was replaced - and after
-- this migration that is load-bearing rather than incidental. A public "ever"
-- is only true while nothing removes rows behind it, and a retention rule
-- added here later would not make the page fail, it would make the page
-- quietly start lying.
--
-- If this table ever does need a rule, the page changes in the same commit: it
-- would have to say "since <date>" and stop saying "ever".
-- `test/StaffSpawnTotalSql.test.ts` asserts that no reaper so much as mentions
-- the table, so a rule written without reading this paragraph fails a test
-- rather than shipping.
--
-- Deliberately not enforced in SQL. `reap()` is SECURITY DEFINER and runs as
-- the owner, so revoking DELETE would stop nobody in a position to write such
-- a rule - it would only look as though it had.
--
-- ## What this publishes
--
-- Nothing the windowed read did not already publish. The same four columns -
-- when, what, how many, which world - and still no `staff_account_id` and no
-- `target_account_id`. The economy page names no account, and an unbounded
-- read is exactly where that property would be easiest to give away by
-- accident.

-- ---------------------------------------------------------------------------
-- the total, over everything
-- ---------------------------------------------------------------------------

-- One row, always. No argument, so there is nothing to clamp, and no LIMIT,
-- because the aggregate has already reduced the table to a single row before
-- any ceiling could apply to it.
--
-- ## The empty answer is a row, not an absence
--
-- On a server where no staff member has ever conjured anything - the case this
-- function exists to prove - it returns `0, 0, null, null`, and it returns it
-- as **one row**. An ungrouped aggregate over an empty table is one row by
-- definition: count(*) is 0, sum() is null and the coalesce makes it 0, and
-- both timestamps are null because there is no first and no last.
--
-- That is the entire contract. The website has to tell "nothing has ever
-- happened" apart from "the read failed", because those are different
-- sentences on the page - the first is the claim it exists to make, the second
-- is an error state. Zero rows would be indistinguishable from a query that
-- returned nothing for any other reason.
--
-- **So do not add a GROUP BY.** It is the one edit that turns this into a
-- function returning no rows at all for an empty table; it reads as tidying,
-- and nothing about the answer on a non-empty table would change to give the
-- mistake away.
--
-- The cast sits on the coalesce rather than the sum because sum(int) is
-- already bigint - what needs pinning is the integer literal it falls back to,
-- so this column's type is decided here rather than by resolution.
CREATE OR REPLACE FUNCTION accounts.public_staff_spawn_total()
RETURNS TABLE (spawns bigint, items bigint, first_at timestamptz, last_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT count(*) AS spawns, coalesce(sum(ss.count), 0)::bigint AS items,
           min(ss.created_at) AS first_at, max(ss.created_at) AS last_at
    FROM public.staff_spawn ss;
$$;

-- ---------------------------------------------------------------------------
-- every spawn there has ever been
-- ---------------------------------------------------------------------------

-- The same four columns in the same order as
-- `accounts.public_staff_spawns(p_days)`, so the website parses one shape
-- whichever of the two it called. What is gone is the window and the ceiling.
--
-- Unbounded, and that is the point rather than an oversight: a list that
-- stopped at five hundred could not be the evidence for a total that did not.
-- These two functions are read together - one is the headline and the other is
-- the table under it - and the page is worth nothing if they can disagree.
--
-- The cost is a scan of a table whose expected size is zero and whose
-- realistic size is a few hundred rows over the life of the server, ordered by
-- `staff_spawn_created_at_idx`, which migration 4 already created. If it ever
-- grows enough for that to matter, something has gone wrong that a LIMIT would
-- hide rather than fix.
CREATE OR REPLACE FUNCTION accounts.public_staff_spawns_all()
RETURNS TABLE (created_at timestamptz, item_id int, count int, world int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT ss.created_at, ss.item_id, ss.count, ss.world
    FROM public.staff_spawn ss
    ORDER BY ss.created_at DESC, ss.id DESC;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Two more functions on the `website` role, taking it to forty-four, and still
-- no privilege of any kind on schema public: `select * from staff_spawn` as
-- website is refused after this migration exactly as it was before it.
--
-- `accounts.public_staff_spawns(int)` keeps its definition and its grant. The
-- website falls back to it until this migration has been applied by hand, and
-- the rollback below needs it already there.

REVOKE ALL ON FUNCTION accounts.public_staff_spawn_total() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.public_staff_spawns_all() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.public_staff_spawn_total() TO website;
GRANT EXECUTE ON FUNCTION accounts.public_staff_spawns_all() TO website;

-- rollback:
--
-- Nothing was created but these two functions, so dropping them restores
-- migration 6 exactly. /economy falls back to the ninety-day window on the
-- next revalidation and stops being able to say "ever"; no row is lost,
-- because no row was written.
--
-- DROP FUNCTION IF EXISTS accounts.public_staff_spawns_all();
-- DROP FUNCTION IF EXISTS accounts.public_staff_spawn_total();
