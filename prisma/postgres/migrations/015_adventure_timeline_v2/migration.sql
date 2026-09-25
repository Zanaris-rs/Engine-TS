-- 015_adventure_timeline_v2: gz, pinned and edited updates, timeline filters,
-- and a player's records on their log.
--
-- Sprint 3 of the Adventurer Log. Readers can say "gz" to an adventure with
-- one click; the owner can pin one update to the top of their log and edit
-- what they posted; the timeline can be narrowed to one kind of entry; and a
-- log shows the owner's best timed XP records (migrations 8 and 9).
--
-- One table, two columns, seven functions. Nothing the game server reads or
-- writes changes, so there is no fleet deploy. The `website` role goes from
-- seventy-seven functions to eighty-four.
--
-- ## gz
--
-- A gz is one row per (adventure, giver). Giving twice is the same as giving
-- once; taking one back deletes the row. It carries no text, so a mute does
-- not stop it. It is refused to:
--
-- - the log's owner, on their own adventures ('self');
-- - a player the owner has blocked ('blocked');
-- - a banned account ('banned');
-- - anyone, on an adventure they cannot see: not on the public profile, in a
--   category the owner hides, or less than twenty minutes old - the same
--   rule the timeline applies to everyone but the owner ('not_found'). A gz
--   must not be a way to learn that something happened sooner.
--
-- 300 gz an hour per giver, counted off the table's own rows under an
-- advisory lock, as updates and replies are. What the timeline shows of a
-- gz leaves out banned givers and givers the owner has blocked, the same as
-- replies. Blocking does not delete anyone's gz: unblocking brings it back.
--
-- ## Pinned and edited updates
--
-- `adventure_log_profile.pinned_update_id` is the one update pinned to the
-- top of a log, or NULL. It is only ever set to one of the owner's own shown
-- updates; if that update is later deleted or hidden by staff, the pin
-- simply shows nothing (adventure_pinned) and nobody has to clear it.
--
-- `adventure_update.edited_at` is when the text last changed, NULL for never.
-- Only the author edits, under the same text rules as posting, and a mute
-- stops an edit as it stops a post. The earlier text is not kept (the
-- owner's decision). Deleted or staff-hidden updates cannot be edited.
--
-- ## The timeline
--
-- `adventure_timeline` gains a seventh argument, p_show: NULL for
-- everything, else a bitmask - bit n shows adventure category n (0..7, as
-- hidden_categories), bit 8 (256) shows updates. It narrows what the owner's
-- hidden categories already allow; it never shows more. The pinned update is
-- never in the timeline itself: the site draws it above, from
-- adventure_pinned. Each row also carries `edited_at`, and for adventures
-- `gz_count`, `gz_names` (the newest fifty givers shown) and `viewer_gz`.
--
-- 013's six-argument `adventure_timeline` is left as it is, still granted:
-- the live site calls it until the website moves to this one. A later
-- migration drops it.
--
-- ## Records
--
-- `adventure_log_records` is a player's place on each duration's Overall
-- board, exactly as `record_board` (migration 8) ranks it: best valid
-- attempt per account on the public profile, more than zero XP, staff above
-- level 1 and banned accounts left out, ordered by XP, then the earlier
-- attempt. Nothing for a player with no place on any board.
--
-- No foreign keys, like every other table.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "adventure_gz" (
    "event_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_gz_pkey" PRIMARY KEY ("event_id", "account_id")
);

CREATE INDEX IF NOT EXISTS "adventure_gz_account_id_created_at_idx" ON "adventure_gz"("account_id", "created_at");

ALTER TABLE "adventure_gz" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "adventure_update" ADD COLUMN IF NOT EXISTS "edited_at" TIMESTAMPTZ(3);
ALTER TABLE "adventure_log_profile" ADD COLUMN IF NOT EXISTS "pinned_update_id" INTEGER;

-- === functions ===

-- ---------------------------------------------------------------------------
-- the public reads
-- ---------------------------------------------------------------------------

-- The timeline, as 013's, narrowed by p_show and without the pinned update.
-- See the header for p_show and the new columns. The cursor and paging are
-- 013's: up to p_limit (1..50) rows, and one more if there is more.
CREATE OR REPLACE FUNCTION accounts.adventure_timeline(p_name text, p_viewer text,
                                                       p_before_at timestamptz, p_before_rank int, p_before_id int,
                                                       p_limit int, p_show int)
RETURNS TABLE (kind text, rank int, id int, at timestamptz, category int, body text, reply_count int,
               edited_at timestamptz, gz_count int, gz_names text[], viewer_gz boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH log AS (
        SELECT a.id, a.username = p_viewer AS is_owner, coalesce(p.hidden_categories, 0) AS hidden,
               p.pinned_update_id AS pinned, coalesce(p_show, 511) AS show
          FROM public.account a
          LEFT JOIN public.adventure_log_profile p ON p.account_id = a.id
         WHERE a.username = p_name
           AND (a.banned_until IS NULL OR a.banned_until <= now())
    ), viewer AS (
        SELECT v.id FROM public.account v WHERE v.username = p_viewer
    ), page AS (
        SELECT least(greatest(coalesce(p_limit, 30), 1), 50) + 1 AS n
    ), adventures AS (
        SELECT 'event'::text AS kind, 0 AS rank, e.id, e.occurred_at AS at, e.category, e.event AS body,
               NULL::int AS reply_count, NULL::timestamptz AS edited_at
          FROM log
          JOIN public.adventure_event e ON e.account_id = log.id AND e.profile = accounts.public_profile()
         WHERE (log.is_owner OR e.occurred_at <= now() - interval '20 minutes')
           AND (log.hidden & (1 << e.category)) = 0
           AND (log.show & (1 << e.category)) <> 0
           AND (p_before_at IS NULL OR (e.occurred_at, 0, e.id) < (p_before_at, p_before_rank, p_before_id))
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT (SELECT n FROM page)
    ), updates AS (
        SELECT 'update'::text, 1, u.id, u.created_at, NULL::int, u.body,
               (SELECT count(*)::int
                  FROM public.adventure_reply r
                  JOIN public.account ra ON ra.id = r.author_account_id
                 WHERE r.update_id = u.id
                   AND r.deleted_at IS NULL AND r.staff_hidden_at IS NULL
                   AND (ra.banned_until IS NULL OR ra.banned_until <= now())
                   AND NOT EXISTS (SELECT 1 FROM public.adventure_block b
                                    WHERE b.owner_account_id = log.id AND b.blocked_account_id = r.author_account_id)),
               u.edited_at
          FROM log
          JOIN public.adventure_update u ON u.account_id = log.id
         WHERE u.deleted_at IS NULL AND u.staff_hidden_at IS NULL
           AND (log.show & 256) <> 0
           AND u.id IS DISTINCT FROM log.pinned
           AND (p_before_at IS NULL OR (u.created_at, 1, u.id) < (p_before_at, p_before_rank, p_before_id))
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT (SELECT n FROM page)
    ), shown AS (
        SELECT t.*
          FROM (SELECT * FROM adventures UNION ALL SELECT * FROM updates) t
         ORDER BY t.at DESC, t.rank DESC, t.id DESC
         LIMIT (SELECT n FROM page)
    )
    SELECT s.kind, s.rank, s.id, s.at, s.category, s.body, s.reply_count, s.edited_at,
           coalesce(g.n, 0), coalesce(g.names, '{}'::text[]), coalesce(g.mine, false)
      FROM shown s
      LEFT JOIN LATERAL (
          SELECT count(*)::int AS n,
                 (array_agg(ga.username ORDER BY gz.created_at DESC, ga.username))[1:50] AS names,
                 bool_or(gz.account_id = (SELECT viewer.id FROM viewer)) AS mine
            FROM public.adventure_gz gz
            JOIN public.account ga ON ga.id = gz.account_id
           WHERE s.kind = 'event' AND gz.event_id = s.id
             AND (ga.banned_until IS NULL OR ga.banned_until <= now())
             AND NOT EXISTS (SELECT 1 FROM log, public.adventure_block b
                              WHERE b.owner_account_id = log.id AND b.blocked_account_id = gz.account_id)
      ) g ON true
     ORDER BY s.at DESC, s.rank DESC, s.id DESC;
$$;

-- The pinned update, in the timeline's shape: no rows when nothing is pinned,
-- or the pinned update is deleted, hidden by staff, or not the owner's, or
-- the log is banned.
CREATE OR REPLACE FUNCTION accounts.adventure_pinned(p_name text, p_viewer text)
RETURNS TABLE (kind text, rank int, id int, at timestamptz, category int, body text, reply_count int,
               edited_at timestamptz, gz_count int, gz_names text[], viewer_gz boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT 'update'::text, 1, u.id, u.created_at, NULL::int, u.body,
           (SELECT count(*)::int
              FROM public.adventure_reply r
              JOIN public.account ra ON ra.id = r.author_account_id
             WHERE r.update_id = u.id
               AND r.deleted_at IS NULL AND r.staff_hidden_at IS NULL
               AND (ra.banned_until IS NULL OR ra.banned_until <= now())
               AND NOT EXISTS (SELECT 1 FROM public.adventure_block b
                                WHERE b.owner_account_id = a.id AND b.blocked_account_id = r.author_account_id)),
           u.edited_at, 0, '{}'::text[], false
      FROM public.account a
      JOIN public.adventure_log_profile p ON p.account_id = a.id
      JOIN public.adventure_update u ON u.id = p.pinned_update_id AND u.account_id = a.id
     WHERE a.username = p_name
       AND (a.banned_until IS NULL OR a.banned_until <= now())
       AND u.deleted_at IS NULL AND u.staff_hidden_at IS NULL;
$$;

-- A player's place on each duration's Overall board, ranked as record_board
-- ranks it. Only durations they have a place on, shortest first.
CREATE OR REPLACE FUNCTION accounts.adventure_log_records(p_name text)
RETURNS TABLE (duration_seconds int, gained bigint, elapsed_ms bigint, achieved_at timestamptz, rank int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.duration_seconds, r.gained, r.elapsed_ms, r.achieved_at, r.rank
      FROM (
        SELECT best.duration_seconds, best.account_id, best.gained, best.elapsed_ms, best.achieved_at,
               (row_number() OVER (PARTITION BY best.duration_seconds
                                   ORDER BY best.gained DESC, best.achieved_at ASC, best.attempt_id ASC))::int AS rank
          FROM (
            SELECT DISTINCT ON (ra.duration_seconds, ra.account_id)
                   ra.duration_seconds, ra.account_id, ra.id AS attempt_id, s.gained, ra.elapsed_ms,
                   ra.final_logout_at AS achieved_at
              FROM public.record_attempt ra
              JOIN public.record_attempt_skill s ON s.attempt_id = ra.id
              JOIN public.account a ON a.id = ra.account_id
             WHERE ra.state = 'valid'
               AND ra.profile = accounts.public_profile()
               AND s.category = 0
               AND s.gained > 0
               AND a.staffmodlevel <= 1
               AND (a.banned_until IS NULL OR a.banned_until < now())
             ORDER BY ra.duration_seconds, ra.account_id, s.gained DESC, ra.final_logout_at ASC, ra.id ASC
          ) best
      ) r
      JOIN public.account owner ON owner.id = r.account_id
     WHERE owner.username = p_name
     ORDER BY r.duration_seconds;
$$;

-- ---------------------------------------------------------------------------
-- gz
-- ---------------------------------------------------------------------------

-- 'ok' | 'not_found' | 'banned' | 'self' | 'blocked' | 'rate_limited'.
CREATE OR REPLACE FUNCTION accounts.adventure_gz_give(p_username text, p_event_id int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_owner_id int;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    -- The adventure, as anyone but its owner sees it.
    SELECT e.account_id INTO v_owner_id
      FROM public.adventure_event e
      JOIN public.account owner ON owner.id = e.account_id
      LEFT JOIN public.adventure_log_profile p ON p.account_id = owner.id
     WHERE e.id = p_event_id
       AND e.profile = accounts.public_profile()
       AND e.occurred_at <= now() - interval '20 minutes'
       AND (coalesce(p.hidden_categories, 0) & (1 << e.category)) = 0
       AND (owner.banned_until IS NULL OR owner.banned_until <= now());
    IF v_owner_id IS NULL THEN RETURN 'not_found'; END IF;
    IF v_owner_id = v_author.account_id THEN RETURN 'self'; END IF;

    IF EXISTS (SELECT 1 FROM public.adventure_block b
                WHERE b.owner_account_id = v_owner_id AND b.blocked_account_id = v_author.account_id) THEN
        RETURN 'blocked';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('adventure_gz:' || v_author.account_id));
    IF EXISTS (SELECT 1 FROM public.adventure_gz g
                WHERE g.event_id = p_event_id AND g.account_id = v_author.account_id) THEN
        RETURN 'ok';
    END IF;
    IF (SELECT count(*) FROM public.adventure_gz g
         WHERE g.account_id = v_author.account_id AND g.created_at > now() - interval '1 hour') >= 300 THEN
        RETURN 'rate_limited';
    END IF;

    INSERT INTO public.adventure_gz (event_id, account_id) VALUES (p_event_id, v_author.account_id)
    ON CONFLICT DO NOTHING;
    RETURN 'ok';
END;
$$;

-- 'ok' | 'not_found' (no such account). Takes the caller's gz back from the
-- first fifty of p_event_ids; ids they never gave to are no matter. Always
-- allowed, banned or not: it only removes their own rows.
CREATE OR REPLACE FUNCTION accounts.adventure_gz_take(p_username text, p_event_ids int[])
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH me AS (
        SELECT a.id FROM public.account a WHERE a.username = p_username
    ), gone AS (
        DELETE FROM public.adventure_gz g
         USING me
         WHERE g.account_id = me.id AND g.event_id = ANY ((p_event_ids)[1:50])
        RETURNING g.event_id
    )
    SELECT CASE WHEN EXISTS (SELECT 1 FROM me) THEN 'ok' ELSE 'not_found' END;
$$;

-- ---------------------------------------------------------------------------
-- the owner's writes
-- ---------------------------------------------------------------------------

-- 'ok' | 'not_found' (no such shown update of theirs) | 'banned' | 'muted' |
-- 'bad_body'. The same text as before is 'ok' and leaves edited_at alone.
CREATE OR REPLACE FUNCTION accounts.adventure_update_edit(p_username text, p_update_id int, p_body text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_body text := accounts.adventure_text(p_body, 2000, false);
    v_old text;
BEGIN
    v_author := accounts.adventure_author(p_username, true);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    SELECT u.body INTO v_old
      FROM public.adventure_update u
     WHERE u.id = p_update_id AND u.account_id = v_author.account_id
       AND u.deleted_at IS NULL AND u.staff_hidden_at IS NULL
       FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF v_body IS NULL THEN RETURN 'bad_body'; END IF;

    IF v_body <> v_old THEN
        UPDATE public.adventure_update SET body = v_body, edited_at = now() WHERE id = p_update_id;
    END IF;
    RETURN 'ok';
END;
$$;

-- 'ok' | 'not_found' (not one of their shown updates) | 'banned'. A NULL
-- p_update_id unpins. Not a mute: it moves words already there.
CREATE OR REPLACE FUNCTION accounts.adventure_log_pin(p_username text, p_update_id int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF p_update_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.adventure_update u
         WHERE u.id = p_update_id AND u.account_id = v_author.account_id
           AND u.deleted_at IS NULL AND u.staff_hidden_at IS NULL) THEN
        RETURN 'not_found';
    END IF;

    INSERT INTO public.adventure_log_profile (account_id, pinned_update_id, updated_at)
    VALUES (v_author.account_id, p_update_id, now())
    ON CONFLICT (account_id) DO UPDATE
       SET pinned_update_id = excluded.pinned_update_id, updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Seven functions on the `website` role, taking it to eighty-four, and still
-- no privilege of any kind on schema public.

REVOKE ALL ON FUNCTION accounts.adventure_timeline(text, text, timestamptz, int, int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_pinned(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log_records(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_gz_give(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_gz_take(text, int[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_update_edit(text, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log_pin(text, int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.adventure_timeline(text, text, timestamptz, int, int, int, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_pinned(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_log_records(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_gz_give(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_gz_take(text, int[]) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_update_edit(text, int, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_log_pin(text, int) TO website;

-- rollback:
--
-- Drops everything this migration made: every gz, every pin, and when each
-- update was edited (the edited text itself stays - it is the update's text
-- now). The website must be back on 013's six-argument timeline first, or
-- its log pages fail.
--
-- DROP FUNCTION IF EXISTS accounts.adventure_log_pin(text, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_update_edit(text, int, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_gz_take(text, int[]);
-- DROP FUNCTION IF EXISTS accounts.adventure_gz_give(text, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_log_records(text);
-- DROP FUNCTION IF EXISTS accounts.adventure_pinned(text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_timeline(text, text, timestamptz, int, int, int, int);
-- ALTER TABLE "adventure_log_profile" DROP COLUMN IF EXISTS "pinned_update_id";
-- ALTER TABLE "adventure_update" DROP COLUMN IF EXISTS "edited_at";
-- DROP TABLE IF EXISTS "adventure_gz";
