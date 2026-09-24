-- 013_adventurer_log: the Adventurer Log itself - a public page per player.
--
-- A log is a timeline: the player's adventures as the game recorded them
-- (migration 11's adventure_event) mixed with the updates they post, with
-- replies from other players under each update. The owner writes a headline
-- and an "about", chooses which kinds of adventure the page shows, styles it
-- with their own CSS, deletes replies and blocks the people who write them.
-- Anyone can read a log; posting, replying and reporting need an account.
--
-- ## The rules, in one place
--
-- - **Twenty minutes.** An adventure reaches everyone else's view of a log
--   twenty minutes after it happened, so a log cannot be used to follow
--   someone around the game. The owner sees their own at once.
-- - **Hidden categories** are a bitmask over adventure_event.category (bit n
--   hides category n) and apply to everyone, the owner included: the page
--   the owner sees is the page everyone sees.
-- - **Text.** Headline 1..80, about up to 1000, an update 1..2000, a reply
--   1..500, a report's reason 1..500 characters, after trimming; newlines and
--   tabs allowed, other control characters not. The site renders text as text;
--   the only markup is its own `[item:...]` / `[skill:...]` shortcodes.
-- - **CSS** is stored as written, up to 20000 characters. It is only ever
--   drawn after the site's sanitiser has been over it, at render time, so a
--   tighter sanitiser applies to every page at once. Staff can disable a
--   log's CSS; the owner cannot then save new CSS until staff enable it again.
-- - **Who may write.** Banned accounts write nothing. Muted accounts may not
--   post, reply, or change their public text (headline, about, CSS) - a mute
--   is a mute on the site too. A player blocked by a log's owner may not reply
--   on it, and their existing replies there are no longer shown.
-- - **Rates**, counted off each table's own rows under an advisory lock per
--   author: 10 updates an hour, 30 replies an hour, 10 reports a day.
-- - **Deleting** is the author's, for updates; for replies it is the author's
--   or the log owner's. Deleted rows are kept (deleted_at), so a report can
--   still be read by staff.
-- - **A banned player's log** answers 'banned': not shown, not written to.
--   Replies from banned authors are not shown on any log.
-- - **Reports** name an update, a reply or a whole log (its headline, about
--   and CSS). One open report per reporter per target. Staff see them in
--   staff_adventure_reports and resolve them with a typed password, the same
--   as game reports: hide (the update or reply, or the log's headline and
--   about), disable_css (a log), or dismiss. Every resolution is a
--   staff_action row.
--
-- No foreign keys, like every other table.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "adventure_log_profile" (
    "account_id" INTEGER NOT NULL,
    "headline" TEXT NOT NULL DEFAULT '',
    "about" TEXT NOT NULL DEFAULT '',
    "custom_css" TEXT NOT NULL DEFAULT '',
    "css_disabled_at" TIMESTAMPTZ(3),
    "hidden_categories" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_log_profile_pkey" PRIMARY KEY ("account_id"),
    CONSTRAINT "adventure_log_profile_headline" CHECK (length("headline") <= 80),
    CONSTRAINT "adventure_log_profile_about" CHECK (length("about") <= 1000),
    CONSTRAINT "adventure_log_profile_css" CHECK (length("custom_css") <= 20000),
    CONSTRAINT "adventure_log_profile_hidden" CHECK ("hidden_categories" BETWEEN 0 AND 255)
);

CREATE TABLE IF NOT EXISTS "adventure_update" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "staff_hidden_at" TIMESTAMPTZ(3),

    CONSTRAINT "adventure_update_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "adventure_update_body" CHECK (length("body") BETWEEN 1 AND 2000)
);

CREATE TABLE IF NOT EXISTS "adventure_reply" (
    "id" SERIAL NOT NULL,
    "update_id" INTEGER NOT NULL,
    "author_account_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "staff_hidden_at" TIMESTAMPTZ(3),

    CONSTRAINT "adventure_reply_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "adventure_reply_body" CHECK (length("body") BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS "adventure_block" (
    "owner_account_id" INTEGER NOT NULL,
    "blocked_account_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_block_pkey" PRIMARY KEY ("owner_account_id", "blocked_account_id"),
    CONSTRAINT "adventure_block_self" CHECK ("owner_account_id" <> "blocked_account_id")
);

CREATE TABLE IF NOT EXISTS "adventure_report" (
    "id" SERIAL NOT NULL,
    "reporter_account_id" INTEGER NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_account_id" INTEGER,
    "resolution" TEXT,
    "note" TEXT,

    CONSTRAINT "adventure_report_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "adventure_report_kind" CHECK ("target_kind" IN ('update', 'reply', 'log')),
    CONSTRAINT "adventure_report_reason" CHECK (length("reason") BETWEEN 1 AND 500),
    CONSTRAINT "adventure_report_resolution" CHECK ("resolution" IS NULL OR "resolution" IN ('hidden', 'css_disabled', 'dismissed')),
    CONSTRAINT "adventure_report_resolved" CHECK (("resolved_at" IS NULL) = ("resolution" IS NULL)),
    CONSTRAINT "adventure_report_note" CHECK ("note" IS NULL OR length("note") <= 1000)
);

CREATE INDEX IF NOT EXISTS "adventure_update_account_id_created_at_idx" ON "adventure_update"("account_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "adventure_reply_update_id_created_at_idx" ON "adventure_reply"("update_id", "created_at");
CREATE INDEX IF NOT EXISTS "adventure_reply_author_account_id_created_at_idx" ON "adventure_reply"("author_account_id", "created_at");
CREATE INDEX IF NOT EXISTS "adventure_report_reporter_account_id_created_at_idx" ON "adventure_report"("reporter_account_id", "created_at");
CREATE INDEX IF NOT EXISTS "adventure_report_resolved_at_created_at_idx" ON "adventure_report"("resolved_at", "created_at");
-- One open report per reporter per target. Postgres only - Prisma cannot say
-- "partial", and nothing else runs these functions.
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_report_one_open_key" ON "adventure_report"("reporter_account_id", "target_kind", "target_id") WHERE "resolved_at" IS NULL;

ALTER TABLE "adventure_log_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "adventure_update" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "adventure_reply" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "adventure_block" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "adventure_report" ENABLE ROW LEVEL SECURITY;

-- === functions ===

-- ---------------------------------------------------------------------------
-- internal helpers: NOT granted to website
-- ---------------------------------------------------------------------------

-- Trimmed text of 1..p_max characters (0..p_max when p_empty_ok), with no
-- control characters but newline and tab; NULL when it is not.
CREATE OR REPLACE FUNCTION accounts.adventure_text(p_value text, p_max int, p_empty_ok boolean) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE
        WHEN v IS NULL THEN NULL
        WHEN length(v) > p_max THEN NULL
        WHEN length(v) = 0 AND NOT p_empty_ok THEN NULL
        WHEN v ~ '[\x01-\x08\x0b-\x1f\x7f]' THEN NULL
        ELSE v
    END
    FROM (SELECT btrim(replace(p_value, E'\r\n', E'\n'), E' \n\t') AS v) t;
$$;

-- Who is writing: 'ok' with their id, or 'not_found' | 'banned' | 'muted'.
-- A mute only matters to writes that put words on a public page, which pass
-- p_speaking.
CREATE OR REPLACE FUNCTION accounts.adventure_author(p_username text, p_speaking boolean, OUT result text, OUT account_id int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_banned_until timestamptz;
    v_muted_until timestamptz;
BEGIN
    SELECT a.id, a.banned_until, a.muted_until INTO account_id, v_banned_until, v_muted_until
      FROM public.account a
     WHERE a.username = p_username;

    IF account_id IS NULL THEN
        result := 'not_found';
    ELSIF v_banned_until IS NOT NULL AND v_banned_until > now() THEN
        result := 'banned';
    ELSIF p_speaking AND v_muted_until IS NOT NULL AND v_muted_until > now() THEN
        result := 'muted';
    ELSE
        result := 'ok';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- the public reads
-- ---------------------------------------------------------------------------

-- A log's header, as p_viewer sees it (NULL for nobody signed in). Always one
-- row: result 'ok' | 'not_found' | 'banned', and the rest only when 'ok'.
-- `custom_css` is as written, with `css_disabled` beside it: the site never
-- draws disabled CSS, but the owner edits it.
CREATE OR REPLACE FUNCTION accounts.adventure_log(p_name text, p_viewer text)
RETURNS TABLE (result text, username text, joined_at timestamptz,
               headline text, about text, custom_css text, css_disabled boolean, hidden_categories int,
               is_owner boolean, viewer_blocked boolean, viewer_can_post boolean,
               gender int, kits jsonb, colours jsonb, worn jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE
               WHEN a.id IS NULL THEN 'not_found'
               WHEN a.banned_until IS NOT NULL AND a.banned_until > now() THEN 'banned'
               ELSE 'ok'
           END,
           a.username, a.registration_date,
           coalesce(p.headline, ''), coalesce(p.about, ''), coalesce(p.custom_css, ''),
           p.css_disabled_at IS NOT NULL, coalesce(p.hidden_categories, 0),
           coalesce(a.username = p_viewer, false),
           coalesce(b.owner_account_id IS NOT NULL, false),
           coalesce(v.id IS NOT NULL
                    AND (v.banned_until IS NULL OR v.banned_until <= now())
                    AND (v.muted_until IS NULL OR v.muted_until <= now())
                    AND b.owner_account_id IS NULL, false),
           o.gender, o.kits::jsonb, o.colours::jsonb, o.worn::jsonb
      FROM (SELECT 1) one
      LEFT JOIN public.account a ON a.username = p_name
      LEFT JOIN public.adventure_log_profile p ON p.account_id = a.id
      LEFT JOIN public.account v ON v.username = p_viewer
      LEFT JOIN public.adventure_block b ON b.owner_account_id = a.id AND b.blocked_account_id = v.id
      LEFT JOIN public.adventure_outfit o ON o.account_id = a.id AND o.is_default;
$$;

-- The timeline, newest first: adventures and updates together. A page is up
-- to p_limit (1..50) rows, and one more if there is more - the site shows
-- p_limit and uses the last one it shows as the next cursor. The cursor is
-- (at, rank, id), strictly before; rank is 0 for an adventure and 1 for an
-- update, which only orders the two when they share a millisecond.
CREATE OR REPLACE FUNCTION accounts.adventure_timeline(p_name text, p_viewer text,
                                                       p_before_at timestamptz, p_before_rank int, p_before_id int,
                                                       p_limit int)
RETURNS TABLE (kind text, rank int, id int, at timestamptz, category int, body text, reply_count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH log AS (
        SELECT a.id, a.username = p_viewer AS is_owner, coalesce(p.hidden_categories, 0) AS hidden
          FROM public.account a
          LEFT JOIN public.adventure_log_profile p ON p.account_id = a.id
         WHERE a.username = p_name
           AND (a.banned_until IS NULL OR a.banned_until <= now())
    ), page AS (
        SELECT least(greatest(coalesce(p_limit, 30), 1), 50) + 1 AS n
    ), adventures AS (
        SELECT 'event'::text AS kind, 0 AS rank, e.id, e.occurred_at AS at, e.category, e.event AS body, NULL::int AS reply_count
          FROM log
          JOIN public.adventure_event e ON e.account_id = log.id AND e.profile = accounts.public_profile()
         WHERE (log.is_owner OR e.occurred_at <= now() - interval '20 minutes')
           AND (log.hidden & (1 << e.category)) = 0
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
                                    WHERE b.owner_account_id = log.id AND b.blocked_account_id = r.author_account_id))
          FROM log
          JOIN public.adventure_update u ON u.account_id = log.id
         WHERE u.deleted_at IS NULL AND u.staff_hidden_at IS NULL
           AND (p_before_at IS NULL OR (u.created_at, 1, u.id) < (p_before_at, p_before_rank, p_before_id))
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT (SELECT n FROM page)
    )
    SELECT t.kind, t.rank, t.id, t.at, t.category, t.body, t.reply_count
      FROM (SELECT * FROM adventures UNION ALL SELECT * FROM updates) t
     ORDER BY t.at DESC, t.rank DESC, t.id DESC
     LIMIT (SELECT n FROM page);
$$;

-- The replies under a page's updates, oldest first, the newest 100 of each.
-- Only updates on p_name's log, only replies still shown: not deleted, not
-- hidden by staff, not by someone the owner blocked or who is banned.
-- can_delete is p_viewer's: the author's own, or anything on their own log.
CREATE OR REPLACE FUNCTION accounts.adventure_replies(p_name text, p_viewer text, p_update_ids int[])
RETURNS TABLE (update_id int, id int, author text, body text, created_at timestamptz, can_delete boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT x.update_id, x.id, x.author, x.body, x.created_at, x.can_delete
      FROM (
        SELECT r.update_id, r.id, ra.username AS author, r.body, r.created_at,
               (ra.username = p_viewer OR owner.username = p_viewer) AS can_delete,
               row_number() OVER (PARTITION BY r.update_id ORDER BY r.created_at DESC, r.id DESC) AS newest
          FROM public.account owner
          JOIN public.adventure_update u ON u.account_id = owner.id
          JOIN public.adventure_reply r ON r.update_id = u.id
          JOIN public.account ra ON ra.id = r.author_account_id
         WHERE owner.username = p_name
           AND (owner.banned_until IS NULL OR owner.banned_until <= now())
           AND u.id = ANY ((p_update_ids)[1:50])
           AND u.deleted_at IS NULL AND u.staff_hidden_at IS NULL
           AND r.deleted_at IS NULL AND r.staff_hidden_at IS NULL
           AND (ra.banned_until IS NULL OR ra.banned_until <= now())
           AND NOT EXISTS (SELECT 1 FROM public.adventure_block b
                            WHERE b.owner_account_id = owner.id AND b.blocked_account_id = r.author_account_id)
      ) x
     WHERE x.newest <= 100
     ORDER BY x.update_id, x.created_at, x.id;
$$;

-- ---------------------------------------------------------------------------
-- the owner's writes
-- ---------------------------------------------------------------------------

-- 'ok' | 'not_found' | 'banned' | 'muted' | 'bad_headline' | 'bad_about'.
CREATE OR REPLACE FUNCTION accounts.adventure_log_save(p_username text, p_headline text, p_about text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_headline text := accounts.adventure_text(p_headline, 80, true);
    v_about text := accounts.adventure_text(p_about, 1000, true);
BEGIN
    v_author := accounts.adventure_author(p_username, true);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    -- a headline is one line
    IF v_headline IS NULL OR position(E'\n' IN v_headline) > 0 THEN RETURN 'bad_headline'; END IF;
    IF v_about IS NULL THEN RETURN 'bad_about'; END IF;

    INSERT INTO public.adventure_log_profile (account_id, headline, about, updated_at)
    VALUES (v_author.account_id, v_headline, v_about, now())
    ON CONFLICT (account_id) DO UPDATE
       SET headline = excluded.headline, about = excluded.about, updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- 'ok' | 'not_found' | 'banned' | 'bad_mask'. Not a mute: it hides, it says
-- nothing.
CREATE OR REPLACE FUNCTION accounts.adventure_log_set_hidden(p_username text, p_mask int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    IF p_mask IS NULL OR p_mask < 0 OR p_mask > 255 THEN RETURN 'bad_mask'; END IF;

    INSERT INTO public.adventure_log_profile (account_id, hidden_categories, updated_at)
    VALUES (v_author.account_id, p_mask, now())
    ON CONFLICT (account_id) DO UPDATE
       SET hidden_categories = excluded.hidden_categories, updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- 'ok' | 'not_found' | 'banned' | 'muted' | 'too_long' | 'css_disabled'.
-- Stored as written; the site sanitises it every time it draws it.
CREATE OR REPLACE FUNCTION accounts.adventure_log_save_css(p_username text, p_css text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
BEGIN
    v_author := accounts.adventure_author(p_username, true);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    IF p_css IS NULL OR length(p_css) > 20000 THEN RETURN 'too_long'; END IF;

    IF EXISTS (SELECT 1 FROM public.adventure_log_profile p
                WHERE p.account_id = v_author.account_id AND p.css_disabled_at IS NOT NULL) THEN
        RETURN 'css_disabled';
    END IF;

    INSERT INTO public.adventure_log_profile (account_id, custom_css, updated_at)
    VALUES (v_author.account_id, p_css, now())
    ON CONFLICT (account_id) DO UPDATE
       SET custom_css = excluded.custom_css, updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- 'ok' with the new id | 'not_found' | 'banned' | 'muted' | 'bad_body' | 'rate_limited'.
CREATE OR REPLACE FUNCTION accounts.adventure_update_post(p_username text, p_body text)
RETURNS TABLE (result text, update_id int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_author record;
    v_body text := accounts.adventure_text(p_body, 2000, false);
    v_id int;
BEGIN
    v_author := accounts.adventure_author(p_username, true);
    IF v_author.result <> 'ok' THEN
        RETURN QUERY SELECT v_author.result, NULL::int;
        RETURN;
    END IF;
    IF v_body IS NULL THEN
        RETURN QUERY SELECT 'bad_body'::text, NULL::int;
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('adventure_update:' || v_author.account_id));
    IF (SELECT count(*) FROM public.adventure_update u
         WHERE u.account_id = v_author.account_id AND u.created_at > now() - interval '1 hour') >= 10 THEN
        RETURN QUERY SELECT 'rate_limited'::text, NULL::int;
        RETURN;
    END IF;

    INSERT INTO public.adventure_update (account_id, body) VALUES (v_author.account_id, v_body)
    RETURNING id INTO v_id;
    RETURN QUERY SELECT 'ok'::text, v_id;
END;
$$;

-- 'ok' | 'not_found' (no such update of theirs, or already deleted).
-- A banned author can still take their own words down.
CREATE OR REPLACE FUNCTION accounts.adventure_update_delete(p_username text, p_update_id int)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH gone AS (
        UPDATE public.adventure_update u SET deleted_at = now()
          FROM public.account a
         WHERE a.username = p_username AND u.account_id = a.id
           AND u.id = p_update_id AND u.deleted_at IS NULL
        RETURNING u.id
    )
    SELECT CASE WHEN EXISTS (SELECT 1 FROM gone) THEN 'ok' ELSE 'not_found' END;
$$;

-- 'ok' with the new id | 'not_found' (author, or no such shown update) |
-- 'banned' | 'muted' | 'blocked' | 'bad_body' | 'rate_limited'.
CREATE OR REPLACE FUNCTION accounts.adventure_reply_post(p_username text, p_update_id int, p_body text)
RETURNS TABLE (result text, reply_id int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_author record;
    v_body text := accounts.adventure_text(p_body, 500, false);
    v_owner_id int;
    v_id int;
BEGIN
    v_author := accounts.adventure_author(p_username, true);
    IF v_author.result <> 'ok' THEN
        RETURN QUERY SELECT v_author.result, NULL::int;
        RETURN;
    END IF;

    SELECT u.account_id INTO v_owner_id
      FROM public.adventure_update u
      JOIN public.account owner ON owner.id = u.account_id
     WHERE u.id = p_update_id
       AND u.deleted_at IS NULL AND u.staff_hidden_at IS NULL
       AND (owner.banned_until IS NULL OR owner.banned_until <= now());
    IF v_owner_id IS NULL THEN
        RETURN QUERY SELECT 'not_found'::text, NULL::int;
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM public.adventure_block b
                WHERE b.owner_account_id = v_owner_id AND b.blocked_account_id = v_author.account_id) THEN
        RETURN QUERY SELECT 'blocked'::text, NULL::int;
        RETURN;
    END IF;

    IF v_body IS NULL THEN
        RETURN QUERY SELECT 'bad_body'::text, NULL::int;
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('adventure_reply:' || v_author.account_id));
    IF (SELECT count(*) FROM public.adventure_reply r
         WHERE r.author_account_id = v_author.account_id AND r.created_at > now() - interval '1 hour') >= 30 THEN
        RETURN QUERY SELECT 'rate_limited'::text, NULL::int;
        RETURN;
    END IF;

    INSERT INTO public.adventure_reply (update_id, author_account_id, body)
    VALUES (p_update_id, v_author.account_id, v_body)
    RETURNING id INTO v_id;
    RETURN QUERY SELECT 'ok'::text, v_id;
END;
$$;

-- 'ok' | 'not_found'. The reply's author may delete it, and so may the owner
-- of the log it is on.
CREATE OR REPLACE FUNCTION accounts.adventure_reply_delete(p_username text, p_reply_id int)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH me AS (
        SELECT a.id FROM public.account a WHERE a.username = p_username
    ), gone AS (
        UPDATE public.adventure_reply r SET deleted_at = now()
          FROM me, public.adventure_update u
         WHERE r.id = p_reply_id AND r.deleted_at IS NULL
           AND u.id = r.update_id
           AND (r.author_account_id = me.id OR u.account_id = me.id)
        RETURNING r.id
    )
    SELECT CASE WHEN EXISTS (SELECT 1 FROM gone) THEN 'ok' ELSE 'not_found' END;
$$;

-- 'ok' | 'not_found' | 'banned' | 'no_such_player' | 'self'. Blocking twice is 'ok'.
CREATE OR REPLACE FUNCTION accounts.adventure_block(p_username text, p_target text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_target_id int;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    SELECT a.id INTO v_target_id FROM public.account a WHERE a.username = p_target;
    IF v_target_id IS NULL THEN RETURN 'no_such_player'; END IF;
    IF v_target_id = v_author.account_id THEN RETURN 'self'; END IF;

    INSERT INTO public.adventure_block (owner_account_id, blocked_account_id)
    VALUES (v_author.account_id, v_target_id)
    ON CONFLICT DO NOTHING;
    RETURN 'ok';
END;
$$;

-- 'ok' | 'not_found' (no such block). Unblocking is always allowed.
CREATE OR REPLACE FUNCTION accounts.adventure_unblock(p_username text, p_target text)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH gone AS (
        DELETE FROM public.adventure_block b
         USING public.account me, public.account them
         WHERE me.username = p_username AND them.username = p_target
           AND b.owner_account_id = me.id AND b.blocked_account_id = them.id
        RETURNING b.blocked_account_id
    )
    SELECT CASE WHEN EXISTS (SELECT 1 FROM gone) THEN 'ok' ELSE 'not_found' END;
$$;

-- The players p_username has blocked, newest first.
CREATE OR REPLACE FUNCTION accounts.adventure_blocks(p_username text)
RETURNS TABLE (username text, blocked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT them.username, b.created_at
      FROM public.account me
      JOIN public.adventure_block b ON b.owner_account_id = me.id
      JOIN public.account them ON them.id = b.blocked_account_id
     WHERE me.username = p_username
     ORDER BY b.created_at DESC, them.username;
$$;

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

-- 'ok' | 'not_found' (reporter, or target) | 'banned' | 'bad_kind' |
-- 'bad_reason' | 'self' | 'already' | 'rate_limited'.
--
-- p_kind 'update' or 'reply' takes p_target_id; 'log' takes p_log_name and
-- reports that log's own text (headline, about, CSS).
CREATE OR REPLACE FUNCTION accounts.adventure_report(p_username text, p_kind text, p_target_id int, p_log_name text, p_reason text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_reason text := accounts.adventure_text(p_reason, 500, false);
    v_target int;
    v_target_owner int;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF p_kind = 'update' THEN
        SELECT u.id, u.account_id INTO v_target, v_target_owner
          FROM public.adventure_update u WHERE u.id = p_target_id AND u.deleted_at IS NULL;
    ELSIF p_kind = 'reply' THEN
        SELECT r.id, r.author_account_id INTO v_target, v_target_owner
          FROM public.adventure_reply r WHERE r.id = p_target_id AND r.deleted_at IS NULL;
    ELSIF p_kind = 'log' THEN
        SELECT a.id, a.id INTO v_target, v_target_owner
          FROM public.account a WHERE a.username = p_log_name;
    ELSE
        RETURN 'bad_kind';
    END IF;

    IF v_target IS NULL THEN RETURN 'not_found'; END IF;
    IF v_target_owner = v_author.account_id THEN RETURN 'self'; END IF;
    IF v_reason IS NULL THEN RETURN 'bad_reason'; END IF;

    PERFORM pg_advisory_xact_lock(hashtext('adventure_report:' || v_author.account_id));
    IF EXISTS (SELECT 1 FROM public.adventure_report r
                WHERE r.reporter_account_id = v_author.account_id AND r.target_kind = p_kind
                  AND r.target_id = v_target AND r.resolved_at IS NULL) THEN
        RETURN 'already';
    END IF;
    IF (SELECT count(*) FROM public.adventure_report r
         WHERE r.reporter_account_id = v_author.account_id AND r.created_at > now() - interval '1 day') >= 10 THEN
        RETURN 'rate_limited';
    END IF;

    INSERT INTO public.adventure_report (reporter_account_id, target_kind, target_id, reason)
    VALUES (v_author.account_id, p_kind, v_target, v_reason);
    RETURN 'ok';
END;
$$;

-- Reports for staff, open ones first then the newest, at most 200. `content`
-- is what was reported as it stands: the update or reply, or for a log its
-- headline and about (its CSS is `css`). `content_state` says whether it is
-- still shown. Nothing for a caller who is not staff.
CREATE OR REPLACE FUNCTION accounts.staff_adventure_reports(p_actor text, p_open_only boolean)
RETURNS TABLE (id int, target_kind text, target_id int, log_owner text, author text, reporter text,
               reason text, created_at timestamptz, content text, css text, content_state text,
               resolved_at timestamptz, resolution text, resolved_by text, note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.id, r.target_kind, r.target_id,
           coalesce(uo.username, ro.username, lo.username),
           coalesce(uo.username, ra.username, lo.username),
           rep.username, r.reason, r.created_at,
           coalesce(u.body, rr.body, CASE WHEN lo.id IS NOT NULL THEN coalesce(lp.headline, '') || E'\n\n' || coalesce(lp.about, '') END),
           CASE WHEN r.target_kind = 'log' THEN coalesce(lp.custom_css, '') END,
           CASE
               WHEN r.target_kind = 'update' THEN CASE WHEN u.deleted_at IS NOT NULL THEN 'deleted' WHEN u.staff_hidden_at IS NOT NULL THEN 'hidden' ELSE 'shown' END
               WHEN r.target_kind = 'reply' THEN CASE WHEN rr.deleted_at IS NOT NULL THEN 'deleted' WHEN rr.staff_hidden_at IS NOT NULL THEN 'hidden' ELSE 'shown' END
               ELSE CASE WHEN lp.css_disabled_at IS NOT NULL THEN 'css_disabled' ELSE 'shown' END
           END,
           r.resolved_at, r.resolution, res.username, r.note
      FROM public.adventure_report r
      JOIN public.account rep ON rep.id = r.reporter_account_id
      LEFT JOIN public.adventure_update u ON r.target_kind = 'update' AND u.id = r.target_id
      LEFT JOIN public.account uo ON uo.id = u.account_id
      LEFT JOIN public.adventure_reply rr ON r.target_kind = 'reply' AND rr.id = r.target_id
      LEFT JOIN public.account ra ON ra.id = rr.author_account_id
      LEFT JOIN public.adventure_update ru ON ru.id = rr.update_id
      LEFT JOIN public.account ro ON ro.id = ru.account_id
      LEFT JOIN public.account lo ON r.target_kind = 'log' AND lo.id = r.target_id
      LEFT JOIN public.adventure_log_profile lp ON lp.account_id = lo.id
      LEFT JOIN public.account res ON res.id = r.resolved_by_account_id
     WHERE accounts.is_staff(p_actor)
       AND (NOT coalesce(p_open_only, false) OR r.resolved_at IS NULL)
     ORDER BY (r.resolved_at IS NULL) DESC, r.created_at DESC, r.id DESC
     LIMIT 200;
$$;

-- 'ok' | 'forbidden' | 'bad_credentials' | 'rate_limited' | 'not_found' | 'invalid'.
--
-- p_action is 'hide' (the update or reply; for a log, its headline and about
-- are cleared), 'disable_css' (a log only) or 'dismiss'. The typed password is
-- checked the way staff_report_resolve checks it, in the same limiter.
CREATE OR REPLACE FUNCTION accounts.staff_adventure_resolve(p_actor text, p_candidate_hash text,
                                                            p_id int, p_action text, p_note text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_actor_id int;
    v_password text;
    v_note text;
    v_report record;
    v_resolution text;
BEGIN
    IF NOT accounts.is_staff(p_actor) THEN RETURN 'forbidden'; END IF;
    IF accounts.throttled('resolve:' || p_actor, p_actor) THEN RETURN 'rate_limited'; END IF;

    SELECT a.id, a.password INTO v_actor_id, v_password FROM public.account a WHERE a.username = p_actor;
    IF p_candidate_hash IS NULL OR length(p_candidate_hash) <> 60
       OR v_password IS NULL OR v_password <> p_candidate_hash THEN
        PERFORM accounts.record_failure('resolve:' || p_actor, p_actor);
        RETURN 'bad_credentials';
    END IF;

    v_note := nullif(btrim(coalesce(p_note, '')), '');
    IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RETURN 'invalid'; END IF;

    SELECT * INTO v_report FROM public.adventure_report r WHERE r.id = p_id;
    IF v_report.id IS NULL THEN RETURN 'not_found'; END IF;

    IF p_action = 'dismiss' THEN
        v_resolution := 'dismissed';
    ELSIF p_action = 'hide' THEN
        v_resolution := 'hidden';
        IF v_report.target_kind = 'update' THEN
            UPDATE public.adventure_update SET staff_hidden_at = now() WHERE id = v_report.target_id AND staff_hidden_at IS NULL;
        ELSIF v_report.target_kind = 'reply' THEN
            UPDATE public.adventure_reply SET staff_hidden_at = now() WHERE id = v_report.target_id AND staff_hidden_at IS NULL;
        ELSE
            UPDATE public.adventure_log_profile SET headline = '', about = '', updated_at = now() WHERE account_id = v_report.target_id;
        END IF;
    ELSIF p_action = 'disable_css' AND v_report.target_kind = 'log' THEN
        v_resolution := 'css_disabled';
        UPDATE public.adventure_log_profile SET css_disabled_at = now(), updated_at = now()
         WHERE account_id = v_report.target_id AND css_disabled_at IS NULL;
    ELSE
        RETURN 'invalid';
    END IF;

    -- Every open report on the same target is answered by the same decision.
    UPDATE public.adventure_report
       SET resolved_at = now(), resolution = v_resolution, resolved_by_account_id = v_actor_id, note = v_note
     WHERE target_kind = v_report.target_kind AND target_id = v_report.target_id
       AND (id = p_id OR resolved_at IS NULL);

    INSERT INTO public.staff_action (actor_account_id, action, target)
    VALUES (v_actor_id, 'staff_adventure_' || v_resolution, 'adventure_report:' || p_id);

    RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Sixteen functions on the `website` role, and still no privilege of any kind
-- on schema public. The two helpers are granted to nobody.

REVOKE ALL ON FUNCTION accounts.adventure_text(text, int, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_author(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_timeline(text, text, timestamptz, int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_replies(text, text, int[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log_save(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log_set_hidden(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log_save_css(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_update_post(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_update_delete(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_reply_post(text, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_reply_delete(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_block(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_unblock(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_blocks(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_report(text, text, int, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_adventure_reports(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_adventure_resolve(text, text, int, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.adventure_log(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_timeline(text, text, timestamptz, int, int, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_replies(text, text, int[]) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_log_save(text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_log_set_hidden(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_log_save_css(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_update_post(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_update_delete(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_reply_post(text, int, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_reply_delete(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_block(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_unblock(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_blocks(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_report(text, text, int, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_adventure_reports(text, boolean) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_adventure_resolve(text, text, int, text, text) TO website;

-- rollback:
--
-- Drops everything this migration made: every log's text and CSS, every
-- update, reply, block and report. The adventures themselves (migration 11)
-- and the outfits (migration 12) stay. Take a dump first.
--
-- DROP FUNCTION IF EXISTS accounts.staff_adventure_resolve(text, text, int, text, text);
-- DROP FUNCTION IF EXISTS accounts.staff_adventure_reports(text, boolean);
-- DROP FUNCTION IF EXISTS accounts.adventure_report(text, text, int, text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_blocks(text);
-- DROP FUNCTION IF EXISTS accounts.adventure_unblock(text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_block(text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_reply_delete(text, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_reply_post(text, int, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_update_delete(text, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_update_post(text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_log_save_css(text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_log_set_hidden(text, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_log_save(text, text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_replies(text, text, int[]);
-- DROP FUNCTION IF EXISTS accounts.adventure_timeline(text, text, timestamptz, int, int, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_log(text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_author(text, boolean);
-- DROP FUNCTION IF EXISTS accounts.adventure_text(text, int, boolean);
-- DROP TABLE IF EXISTS "adventure_report";
-- DROP TABLE IF EXISTS "adventure_block";
-- DROP TABLE IF EXISTS "adventure_reply";
-- DROP TABLE IF EXISTS "adventure_update";
-- DROP TABLE IF EXISTS "adventure_log_profile";
