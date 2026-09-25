-- 014_adventure_directory: the list of adventurer logs, and the replies on
-- your own log.
--
-- Sprint 2 of the Adventurer Log gives `/adventurer-log` (no name) a page of
-- its own: the logs with something public on them, the most recently active
-- first, each with its owner's headline and the newest thing on it. The
-- owner's log management gains "Recent replies on your log", so a reply can
-- be deleted, or its author blocked or unblocked, without finding it on the
-- page first.
--
-- Two functions and one index. No table and nothing the game server writes
-- changes, so there is no fleet deploy. The `website` role goes from
-- seventy-five functions to seventy-seven.
--
-- ## adventure_log_directory
--
-- One row per log, for its latest *public* activity: what someone who is not
-- the owner sees at the top of that log (013's adventure_timeline with no
-- viewer). That is the newer of
--
-- - the newest adventure on the public profile that is at least twenty
--   minutes old and in a category the owner has not hidden, and
-- - the newest update that is neither deleted nor hidden by staff.
--
-- When the two share a millisecond the update wins, as it does at the top of
-- the timeline. "Active" never means logged in: an adventure from ten minutes
-- ago does not move a log up yet, and logging in and doing nothing never does.
-- Banned accounts are left out, and so is every account with nothing public.
--
-- Newest first, then by name. The cursor is the last row's (last_at, username)
-- and a page is strictly after it; a NULL p_before_at is the first page. A
-- page is up to p_limit (1..50, NULL 30) rows, and one more if there is more,
-- as in adventure_timeline.
--
-- ### What a page costs
--
-- adventure_event only grows, so the directory never reads it by time. It asks
-- each account for its newest shown adventure - one step down an index - and
-- sorts the answers. A page therefore costs the same at any depth, and grows
-- with the number of accounts, not with the number of adventures.
--
-- The index below is 011's (account_id, profile, occurred_at) with the
-- category carried in it, so that step reads the index alone, hidden
-- categories included, and never the table. Postgres only: Prisma cannot say
-- INCLUDE, and nothing else runs these functions. On the rehearsal database
-- (5,000 accounts, 500,000 adventures, 2,000 updates) a page takes about 25 ms,
-- the first or a deep one. Building the index holds up the login server's
-- adventure writes until it is done: a moment at the table's size in its
-- first week, well inside the login server's ten-second query timeout.
--
-- JIT is off for the directory. With enough accounts the planner prices the
-- index steps high enough to compile the query, and compiling takes several
-- times longer than running it.
--
-- ## adventure_log_recent_replies
--
-- The replies under p_username's shown updates, newest first, p_limit of them
-- (1..100, NULL 30): not deleted, not hidden by staff. A reply from a player
-- the owner has blocked is in the list, marked author_blocked, because this is
-- where the owner unblocks them; a reply from a banned player is not, as on
-- the log itself. Nothing for an unknown or banned owner.

-- ---------------------------------------------------------------------------
-- index
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "adventure_event_directory_idx" ON "adventure_event"("account_id", "profile", "occurred_at" DESC) INCLUDE ("category");

-- === functions ===

-- A page of the directory. The newest shown adventure and update of every
-- account first, by time only; then the row itself for the page's accounts,
-- the highest id at that time, as the timeline orders them.
CREATE OR REPLACE FUNCTION accounts.adventure_log_directory(p_before_at timestamptz, p_before_username text, p_limit int)
RETURNS TABLE (username text, headline text, last_at timestamptz, last_kind text, last_category int, last_body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
    WITH latest AS (
        SELECT a.id, a.username, coalesce(p.headline, '') AS headline, coalesce(p.hidden_categories, 0) AS hidden,
               e.at AS event_at, u.at AS update_at
          FROM public.account a
          LEFT JOIN public.adventure_log_profile p ON p.account_id = a.id
          LEFT JOIN LATERAL (
              SELECT e.occurred_at AS at
                FROM public.adventure_event e
               WHERE e.account_id = a.id AND e.profile = accounts.public_profile()
                 AND e.occurred_at <= now() - interval '20 minutes'
                 AND (coalesce(p.hidden_categories, 0) & (1 << e.category)) = 0
               ORDER BY e.occurred_at DESC
               LIMIT 1
          ) e ON true
          LEFT JOIN LATERAL (
              SELECT u.created_at AS at
                FROM public.adventure_update u
               WHERE u.account_id = a.id AND u.deleted_at IS NULL AND u.staff_hidden_at IS NULL
               ORDER BY u.created_at DESC
               LIMIT 1
          ) u ON true
         WHERE (a.banned_until IS NULL OR a.banned_until <= now())
           AND (e.at IS NOT NULL OR u.at IS NOT NULL)
    ), page AS (
        SELECT l.id, l.username, l.headline, l.hidden,
               greatest(l.event_at, l.update_at) AS at,
               l.update_at IS NOT NULL AND (l.event_at IS NULL OR l.update_at >= l.event_at) AS is_update
          FROM latest l
         WHERE p_before_at IS NULL
            OR greatest(l.event_at, l.update_at) < p_before_at
            OR (greatest(l.event_at, l.update_at) = p_before_at AND l.username > coalesce(p_before_username, ''))
         ORDER BY greatest(l.event_at, l.update_at) DESC, l.username
         LIMIT least(greatest(coalesce(p_limit, 30), 1), 50) + 1
    )
    SELECT pg.username, pg.headline, pg.at,
           CASE WHEN pg.is_update THEN 'update' ELSE 'event' END,
           ev.category,
           coalesce(up.body, ev.event)
      FROM page pg
      LEFT JOIN LATERAL (
          SELECT u.body
            FROM public.adventure_update u
           WHERE pg.is_update AND u.account_id = pg.id AND u.created_at = pg.at
             AND u.deleted_at IS NULL AND u.staff_hidden_at IS NULL
           ORDER BY u.id DESC
           LIMIT 1
      ) up ON true
      LEFT JOIN LATERAL (
          SELECT e.category, e.event
            FROM public.adventure_event e
           WHERE NOT pg.is_update AND e.account_id = pg.id AND e.profile = accounts.public_profile()
             AND e.occurred_at = pg.at AND (pg.hidden & (1 << e.category)) = 0
           ORDER BY e.id DESC
           LIMIT 1
      ) ev ON true
     ORDER BY pg.at DESC, pg.username;
$$;

-- The owner's recent replies, for log management.
CREATE OR REPLACE FUNCTION accounts.adventure_log_recent_replies(p_username text, p_limit int)
RETURNS TABLE (reply_id int, update_id int, author text, body text, created_at timestamptz, update_body text, author_blocked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.id, u.id, ra.username, r.body, r.created_at, u.body,
           EXISTS (SELECT 1 FROM public.adventure_block b
                    WHERE b.owner_account_id = owner.id AND b.blocked_account_id = r.author_account_id)
      FROM public.account owner
      JOIN public.adventure_update u ON u.account_id = owner.id
      JOIN public.adventure_reply r ON r.update_id = u.id
      JOIN public.account ra ON ra.id = r.author_account_id
     WHERE owner.username = p_username
       AND (owner.banned_until IS NULL OR owner.banned_until <= now())
       AND u.deleted_at IS NULL AND u.staff_hidden_at IS NULL
       AND r.deleted_at IS NULL AND r.staff_hidden_at IS NULL
       AND (ra.banned_until IS NULL OR ra.banned_until <= now())
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Two more functions on the `website` role, and still no privilege of any
-- kind on schema public.

REVOKE ALL ON FUNCTION accounts.adventure_log_directory(timestamptz, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log_recent_replies(text, int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.adventure_log_directory(timestamptz, text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_log_recent_replies(text, int) TO website;

-- rollback:
--
-- Drops the two functions and the index. Nothing else was made, and no row
-- was written.
--
-- DROP FUNCTION IF EXISTS accounts.adventure_log_recent_replies(text, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_log_directory(timestamptz, text, int);
-- DROP INDEX IF EXISTS "adventure_event_directory_idx";
