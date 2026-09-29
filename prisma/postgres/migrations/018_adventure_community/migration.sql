-- 018_adventure_community: the headline folds into the dialogue, whole parts
-- of a log can be hidden, About moves to the Sheet, and posts are shorter.
--
-- Sprint 6 of the Adventurer Log. The owner's headline goes: page 1 of the
-- dialogue speaks for them instead, and every page gets its own overhead
-- colour and effect. Log settings can hide whole parts of a log, not only
-- kinds of adventure. About is saved with the rest of Character > Sheet.
-- Updates, replies and clan notices stop at 200 characters.
--
-- adventure_log_profile loses headline and gains hidden_parts;
-- adventure_persona loses headline_colour and headline_effect; the functions
-- that post updates, replies and notices take 200 characters. Nothing the
-- game server reads or writes changes, so there is no fleet deploy. The
-- `website` role goes from one hundred and eight functions to one hundred
-- and seven.
--
-- ## The headline becomes page 1
--
-- - **Pages.** A dialogue page is {mood, emote, lines, colour, effect}:
--   colour is one of the game's twelve chat colours (0..11) and effect one
--   of none, wave and scroll (0..2), each 0 when a save leaves it out. Colour
--   and effect are picks, so a mute does not stop them changing.
-- - **The greeting** is page 1's first line in page 1's colour and effect,
--   or ('', 0, 0) with no pages: what the directory, the Community square,
--   link previews and the chat strip show of a player. adventure_greeting
--   works it out; adventure_log and adventure_log_directory return it.
-- - **The move.** Every existing page takes its persona's headline colour
--   and effect. A non-empty headline of 60 characters or fewer, on a log
--   with fewer than five pages, becomes a new page 1: mood neutral, no
--   emote, the headline as its one line, in the persona's colour and effect
--   (0 and 0 for a log that never saved a persona, which gets one here).
--   Every other headline is dropped: only testers have written them. The
--   move prints how many it moved and dropped, and how many old posts are
--   over the new limit, as NOTICE lines (`018: ...`) in the apply log: that
--   log is the record of the count. Both tables are locked against writes
--   while it runs. It runs once: applied again, the headline column is gone
--   and the move is skipped.
-- - headline, headline_colour and headline_effect are then dropped, with
--   their checks.
--
-- ## What a log shows
--
-- - adventure_log_profile.hidden_parts is a bitmask of the log's parts,
--   hidden for everyone, the owner included, as hidden_categories is:
--   dialogue 1, wardrobe 2, records 4, about 8, adventures 16 (0..31). The
--   website draws what it says; the character card and the skills are
--   never hidden.
-- - A log with adventures hidden has no public activity: the directory,
--   which lists only accounts with something public, leaves it out, and so
--   does everything that reads the directory (the Community hub's Recent
--   activity and its square).
-- - adventure_log_save_shows saves both masks in one go. They hide and say
--   nothing, so a mute does not matter, as with 013's adventure_log_set_hidden,
--   which it replaces.
--
-- ## About
--
-- - About is saved by adventure_persona_save_sheet, with the title, examine,
--   hangout, goals, god and home town, in the same transaction; it is still
--   kept on adventure_log_profile. A mute refuses the save when About would
--   change, as it does for the sheet's other words. adventure_log_save,
--   which saved About and the headline, is dropped.
--
-- ## 200 characters
--
-- - An update, a reply and a clan notice's body are 1..200 characters. The
--   four functions that write them check it, and they are the only way the
--   website writes a body. The tables' own checks stay as 013 and 017 made
--   them (2000, 500 and 280): Postgres checks every row an UPDATE writes,
--   whichever columns change, so a tighter table check would stop an older,
--   longer post from being deleted, hidden by staff or pinned.
-- - Saving an update's text unchanged is still 'ok' and writes nothing, so
--   an old long update can be left alone; an edit that changes it must
--   bring it to 200 or under.
--
-- ## Functions
--
-- - Dropped: adventure_log_save, adventure_log_set_hidden, and the six- and
--   seven-argument persona writers.
-- - Made anew, because their columns change, and granted again:
--   adventure_log (no headline; greeting, greeting_colour, greeting_effect
--   and hidden_parts appended), adventure_log_directory (the three greeting
--   columns in the headline's place) and adventure_persona (no
--   headline_colour or headline_effect).
-- - New, granted: adventure_persona_save_words (signature emote and
--   dialogue), adventure_persona_save_sheet (the sheet and About) and
--   adventure_log_save_shows.
-- - New, withheld: adventure_greeting.
-- - Replaced in place, same signatures, keeping their grants:
--   adventure_dialogue (withheld: pages carry colour and effect),
--   adventure_update_post, adventure_update_edit, adventure_reply_post and
--   clan_notice_post (200 characters), staff_adventure_reports (a log's
--   content is its greeting and About) and staff_adventure_resolve (a hide
--   on a log no longer touches the headline).
--
-- No foreign keys, like every other table.

-- ---------------------------------------------------------------------------
-- what goes: the old writers, and the reads whose columns change
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS accounts.adventure_log_save(text, text, text);
DROP FUNCTION IF EXISTS accounts.adventure_log_set_hidden(text, int);
DROP FUNCTION IF EXISTS accounts.adventure_persona_save_words(text, text, int, int, text, jsonb);
DROP FUNCTION IF EXISTS accounts.adventure_persona_save_sheet(text, text, text, text, jsonb, text, text);
-- Their result columns change, which CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS accounts.adventure_log(text, text);
DROP FUNCTION IF EXISTS accounts.adventure_log_directory(timestamptz, text, int);
DROP FUNCTION IF EXISTS accounts.adventure_persona(text);

-- ---------------------------------------------------------------------------
-- the move: headlines into page 1, colours and effects onto every page
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_moved int;
    v_made int;
    v_dropped int;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'adventure_log_profile'
                      AND column_name = 'headline') THEN
        RETURN; -- moved already: this file is being applied again
    END IF;

    -- No save lands between the counts and the writes.
    LOCK TABLE public.adventure_log_profile, public.adventure_persona IN EXCLUSIVE MODE;

    SELECT count(*) INTO v_dropped
      FROM public.adventure_log_profile pr
      LEFT JOIN public.adventure_persona pe ON pe.account_id = pr.account_id
     WHERE pr.headline <> ''
       AND (length(pr.headline) > 60 OR jsonb_array_length(coalesce(pe.dialogue, '[]')::jsonb) >= 5);

    -- Every page takes its persona's colour and effect.
    UPDATE public.adventure_persona pe
       SET dialogue = (SELECT jsonb_agg(t.page || jsonb_build_object('colour', pe.headline_colour::int,
                                                                     'effect', pe.headline_effect::int)
                                        ORDER BY t.n)
                         FROM jsonb_array_elements(pe.dialogue::jsonb) WITH ORDINALITY AS t(page, n))::text
     WHERE jsonb_array_length(pe.dialogue::jsonb) > 0;

    -- A headline that fits becomes page 1, in the same colour and effect.
    UPDATE public.adventure_persona pe
       SET dialogue = (jsonb_build_array(jsonb_build_object(
                           'mood', 'neutral', 'emote', NULL, 'lines', jsonb_build_array(pr.headline),
                           'colour', pe.headline_colour::int, 'effect', pe.headline_effect::int))
                       || pe.dialogue::jsonb)::text
      FROM public.adventure_log_profile pr
     WHERE pr.account_id = pe.account_id
       AND pr.headline <> '' AND length(pr.headline) <= 60
       AND jsonb_array_length(pe.dialogue::jsonb) < 5;
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    -- A log that never saved a persona gets one, holding that page.
    INSERT INTO public.adventure_persona (account_id, dialogue)
    SELECT pr.account_id,
           jsonb_build_array(jsonb_build_object(
               'mood', 'neutral', 'emote', NULL, 'lines', jsonb_build_array(pr.headline),
               'colour', 0, 'effect', 0))::text
      FROM public.adventure_log_profile pr
     WHERE pr.headline <> '' AND length(pr.headline) <= 60
       AND NOT EXISTS (SELECT 1 FROM public.adventure_persona pe WHERE pe.account_id = pr.account_id);
    GET DIAGNOSTICS v_made = ROW_COUNT;

    RAISE NOTICE '018: headlines moved into dialogue page 1: %; dropped (over 60 characters, or five pages already): %',
        v_moved + v_made, v_dropped;
    RAISE NOTICE '018: kept as they are, over 200 characters: updates %, replies %, clan notices %',
        (SELECT count(*) FROM public.adventure_update u WHERE length(u.body) > 200),
        (SELECT count(*) FROM public.adventure_reply r WHERE length(r.body) > 200),
        (SELECT count(*) FROM public.adventure_clan_notice n WHERE length(n.body) > 200);
END $$;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

ALTER TABLE "adventure_log_profile" DROP CONSTRAINT IF EXISTS "adventure_log_profile_headline";
ALTER TABLE "adventure_log_profile" DROP COLUMN IF EXISTS "headline";
ALTER TABLE "adventure_log_profile" ADD COLUMN IF NOT EXISTS "hidden_parts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "adventure_log_profile" DROP CONSTRAINT IF EXISTS "adventure_log_profile_parts";
ALTER TABLE "adventure_log_profile" ADD CONSTRAINT "adventure_log_profile_parts" CHECK ("hidden_parts" BETWEEN 0 AND 31);

ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_colour";
ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_effect";
ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "headline_colour";
ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "headline_effect";

-- === functions ===

-- ---------------------------------------------------------------------------
-- internal helpers: NOT granted to website
-- ---------------------------------------------------------------------------

-- Dialogue as stored: up to five pages of {mood, emote, lines, colour,
-- effect}, each line a trimmed one-line string of 1..60 characters, one to
-- four lines a page, no other keys; a missing emote is null, and a missing
-- colour or effect is 0 (018). colour is a whole JSON number 0..11 and
-- effect one 0..2. NULL for anything else.
CREATE OR REPLACE FUNCTION accounts.adventure_dialogue(p_dialogue jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_page jsonb;
    v_line jsonb;
    v_lines jsonb;
    v_text text;
    v_number numeric;
    v_colour int;
    v_effect int;
    v_out jsonb := '[]'::jsonb;
BEGIN
    IF p_dialogue IS NULL OR jsonb_typeof(p_dialogue) <> 'array' OR jsonb_array_length(p_dialogue) > 5 THEN
        RETURN NULL;
    END IF;
    FOR v_page IN SELECT value FROM jsonb_array_elements(p_dialogue) LOOP
        IF jsonb_typeof(v_page) <> 'object'
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_page) k WHERE k NOT IN ('mood', 'emote', 'lines', 'colour', 'effect'))
           OR jsonb_typeof(v_page -> 'mood') IS DISTINCT FROM 'string'
           OR NOT ((v_page ->> 'mood') = ANY (accounts.adventure_moods()))
           OR NOT (v_page -> 'emote' IS NULL
                   OR jsonb_typeof(v_page -> 'emote') = 'null'
                   OR (jsonb_typeof(v_page -> 'emote') = 'string'
                       AND (v_page ->> 'emote') = ANY (accounts.adventure_emotes())))
           OR jsonb_typeof(v_page -> 'lines') IS DISTINCT FROM 'array'
           OR jsonb_array_length(v_page -> 'lines') NOT BETWEEN 1 AND 4 THEN
            RETURN NULL;
        END IF;

        v_colour := 0;
        IF v_page ? 'colour' THEN
            IF jsonb_typeof(v_page -> 'colour') <> 'number' THEN RETURN NULL; END IF;
            v_number := (v_page ->> 'colour')::numeric;
            IF v_number NOT BETWEEN 0 AND 11 OR v_number <> trunc(v_number) THEN RETURN NULL; END IF;
            v_colour := v_number::int;
        END IF;
        v_effect := 0;
        IF v_page ? 'effect' THEN
            IF jsonb_typeof(v_page -> 'effect') <> 'number' THEN RETURN NULL; END IF;
            v_number := (v_page ->> 'effect')::numeric;
            IF v_number NOT BETWEEN 0 AND 2 OR v_number <> trunc(v_number) THEN RETURN NULL; END IF;
            v_effect := v_number::int;
        END IF;

        v_lines := '[]'::jsonb;
        FOR v_line IN SELECT value FROM jsonb_array_elements(v_page -> 'lines') LOOP
            IF jsonb_typeof(v_line) <> 'string' THEN RETURN NULL; END IF;
            v_text := accounts.adventure_text(v_line #>> '{}', 60, false);
            IF v_text IS NULL OR position(E'\n' IN v_text) > 0 THEN RETURN NULL; END IF;
            v_lines := v_lines || to_jsonb(v_text);
        END LOOP;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
            'mood', v_page ->> 'mood',
            'emote', CASE WHEN jsonb_typeof(v_page -> 'emote') = 'string' THEN v_page -> 'emote' ELSE 'null'::jsonb END,
            'lines', v_lines,
            'colour', v_colour,
            'effect', v_effect));
    END LOOP;
    RETURN v_out;
END;
$$;

-- The greeting: page 1's first line, in page 1's colour and effect, or
-- ('', 0, 0) when there are no pages. Always one row.
CREATE OR REPLACE FUNCTION accounts.adventure_greeting(p_dialogue jsonb)
RETURNS TABLE (greeting text, colour int, effect int)
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT coalesce(p_dialogue -> 0 -> 'lines' ->> 0, ''),
           coalesce((p_dialogue -> 0 ->> 'colour')::int, 0),
           coalesce((p_dialogue -> 0 ->> 'effect')::int, 0)
$$;

-- ---------------------------------------------------------------------------
-- the public reads, made anew
-- ---------------------------------------------------------------------------

-- A log's header, as p_viewer sees it (NULL for nobody signed in). Always one
-- row: result 'ok' | 'not_found' | 'banned', and the rest only when 'ok'.
-- `custom_css` is as written, with `css_disabled` beside it: the site never
-- draws disabled CSS, but the owner edits it. 018: no headline; the greeting
-- (page 1's first line, colour and effect) and the hidden parts come last.
CREATE OR REPLACE FUNCTION accounts.adventure_log(p_name text, p_viewer text)
RETURNS TABLE (result text, username text, joined_at timestamptz,
               about text, custom_css text, css_disabled boolean, hidden_categories int,
               is_owner boolean, viewer_blocked boolean, viewer_can_post boolean,
               gender int, kits jsonb, colours jsonb, worn jsonb,
               greeting text, greeting_colour int, greeting_effect int, hidden_parts int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE
               WHEN a.id IS NULL THEN 'not_found'
               WHEN a.banned_until IS NOT NULL AND a.banned_until > now() THEN 'banned'
               ELSE 'ok'
           END,
           a.username, a.registration_date,
           coalesce(p.about, ''), coalesce(p.custom_css, ''),
           p.css_disabled_at IS NOT NULL, coalesce(p.hidden_categories, 0),
           coalesce(a.username = p_viewer, false),
           coalesce(b.owner_account_id IS NOT NULL, false),
           coalesce(v.id IS NOT NULL
                    AND (v.banned_until IS NULL OR v.banned_until <= now())
                    AND (v.muted_until IS NULL OR v.muted_until <= now())
                    AND b.owner_account_id IS NULL, false),
           o.gender, o.kits::jsonb, o.colours::jsonb, o.worn::jsonb,
           g.greeting, g.colour, g.effect, coalesce(p.hidden_parts, 0)
      FROM (SELECT 1) one
      LEFT JOIN public.account a ON a.username = p_name
      LEFT JOIN public.adventure_log_profile p ON p.account_id = a.id
      LEFT JOIN public.adventure_persona pe ON pe.account_id = a.id
      LEFT JOIN LATERAL accounts.adventure_greeting(pe.dialogue::jsonb) g ON true
      LEFT JOIN public.account v ON v.username = p_viewer
      LEFT JOIN public.adventure_block b ON b.owner_account_id = a.id AND b.blocked_account_id = v.id
      LEFT JOIN public.adventure_outfit o ON o.account_id = a.id AND o.is_default;
$$;

-- A page of the directory, as 014's: the newest shown adventure and update
-- of every account first, by time only; then the row itself for the page's
-- accounts, the highest id at that time, as the timeline orders them. 018:
-- each row carries the owner's greeting in the headline's place, and a log
-- whose owner hides its adventures (hidden_parts bit 16) has nothing public,
-- so it is left out.
CREATE OR REPLACE FUNCTION accounts.adventure_log_directory(p_before_at timestamptz, p_before_username text, p_limit int)
RETURNS TABLE (username text, greeting text, greeting_colour int, greeting_effect int,
               last_at timestamptz, last_kind text, last_category int, last_body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
    WITH latest AS (
        SELECT a.id, a.username, coalesce(p.hidden_categories, 0) AS hidden,
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
           AND (coalesce(p.hidden_parts, 0) & 16) = 0
           AND (e.at IS NOT NULL OR u.at IS NOT NULL)
    ), page AS (
        SELECT l.id, l.username, l.hidden,
               greatest(l.event_at, l.update_at) AS at,
               l.update_at IS NOT NULL AND (l.event_at IS NULL OR l.update_at >= l.event_at) AS is_update
          FROM latest l
         WHERE p_before_at IS NULL
            OR greatest(l.event_at, l.update_at) < p_before_at
            OR (greatest(l.event_at, l.update_at) = p_before_at AND l.username > coalesce(p_before_username, ''))
         ORDER BY greatest(l.event_at, l.update_at) DESC, l.username
         LIMIT least(greatest(coalesce(p_limit, 30), 1), 50) + 1
    )
    SELECT pg.username, g.greeting, g.colour, g.effect, pg.at,
           CASE WHEN pg.is_update THEN 'update' ELSE 'event' END,
           ev.category,
           coalesce(up.body, ev.event)
      FROM page pg
      LEFT JOIN public.adventure_persona pe ON pe.account_id = pg.id
      LEFT JOIN LATERAL accounts.adventure_greeting(pe.dialogue::jsonb) g ON true
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

-- A log's persona, for anyone: zero rows for no account, a banned one, or a
-- persona never saved. 018: no headline colour or effect; each dialogue page
-- carries its own.
CREATE OR REPLACE FUNCTION accounts.adventure_persona(p_name text)
RETURNS TABLE (title text, examine text, hangout text, goals jsonb, god text, home_town text, scene text,
               facing int, signature_emote text, dialogue jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT pe.title, pe.examine, pe.hangout, pe.goals::jsonb, pe.god, pe.home_town, pe.scene,
           pe.facing::int, pe.signature_emote, pe.dialogue::jsonb
      FROM public.account a
      JOIN public.adventure_persona pe ON pe.account_id = a.id
     WHERE a.username = p_name
       AND (a.banned_until IS NULL OR a.banned_until <= now());
$$;

-- ---------------------------------------------------------------------------
-- the owner's writes
-- ---------------------------------------------------------------------------

-- Character > Words: the signature emote and the dialogue, each page with its
-- own colour and effect. Makes the persona row on first save; touches nothing
-- the other two tabs save. A mute refuses the save only when the dialogue's
-- lines, in order, would change: moods, emotes, colours and effects are
-- picks.
-- 'ok' | 'not_found' | 'banned' | 'muted' | 'bad_emote' | 'bad_dialogue'.
CREATE OR REPLACE FUNCTION accounts.adventure_persona_save_words(p_username text, p_emote text, p_dialogue jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_muted boolean;
    v_old jsonb;
    v_dialogue jsonb := accounts.adventure_dialogue(p_dialogue);
BEGIN
    -- Not "speaking": a mute is checked below, against the lines only.
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF p_emote IS NOT NULL AND NOT (p_emote = ANY (accounts.adventure_emotes())) THEN RETURN 'bad_emote'; END IF;
    IF v_dialogue IS NULL THEN RETURN 'bad_dialogue'; END IF;

    -- A staff "hide" on the log blanks these words under the same lock, so
    -- the words read below cannot be written back over a hide.
    PERFORM pg_advisory_xact_lock(hashtext('adventure_persona:' || v_author.account_id));
    SELECT a.muted_until IS NOT NULL AND a.muted_until > now() INTO v_muted
      FROM public.account a WHERE a.id = v_author.account_id;
    IF v_muted THEN
        SELECT coalesce(pe.dialogue, '[]')::jsonb INTO v_old
          FROM (SELECT 1) one
          LEFT JOIN public.adventure_persona pe ON pe.account_id = v_author.account_id;
        IF accounts.adventure_dialogue_lines(v_old) IS DISTINCT FROM accounts.adventure_dialogue_lines(v_dialogue) THEN
            RETURN 'muted';
        END IF;
    END IF;

    INSERT INTO public.adventure_persona (account_id, signature_emote, dialogue, updated_at)
    VALUES (v_author.account_id, p_emote, v_dialogue::text, now())
    ON CONFLICT (account_id) DO UPDATE SET
        signature_emote = excluded.signature_emote, dialogue = excluded.dialogue,
        updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- Character > Sheet: title, examine, hangout, goals, god, home town and,
-- from 018, About (up to 1000 characters; newlines allowed), which stays on
-- adventure_log_profile and is saved in the same transaction. A mute refuses
-- the save only when the title, examine, hangout, a goal or About would
-- change.
-- 'ok' | 'not_found' | 'banned' | 'muted' | 'bad_title' | 'bad_examine' |
-- 'bad_hangout' | 'bad_goals' | 'bad_god' | 'bad_key' | 'bad_about'.
CREATE OR REPLACE FUNCTION accounts.adventure_persona_save_sheet(p_username text, p_title text, p_examine text,
                                                                 p_hangout text, p_goals jsonb, p_god text, p_home text,
                                                                 p_about text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_muted boolean;
    v_old record;
    v_title text := accounts.adventure_text(p_title, 24, true);
    v_examine text := accounts.adventure_text(p_examine, 80, true);
    v_hangout text := accounts.adventure_text(p_hangout, 40, true);
    v_goals jsonb := accounts.adventure_goals(p_goals);
    v_about text := accounts.adventure_text(p_about, 1000, true);
BEGIN
    -- Not "speaking": a mute is checked below, against the words only.
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF v_title IS NULL OR position(E'\n' IN v_title) > 0 THEN RETURN 'bad_title'; END IF;
    IF v_examine IS NULL OR position(E'\n' IN v_examine) > 0 THEN RETURN 'bad_examine'; END IF;
    IF v_hangout IS NULL OR position(E'\n' IN v_hangout) > 0 THEN RETURN 'bad_hangout'; END IF;
    IF v_goals IS NULL THEN RETURN 'bad_goals'; END IF;
    IF p_god IS NOT NULL AND p_god NOT IN ('saradomin', 'zamorak', 'guthix') THEN RETURN 'bad_god'; END IF;
    IF p_home IS NOT NULL AND p_home !~ '^[a-z_]{1,24}$' THEN RETURN 'bad_key'; END IF;
    IF v_about IS NULL THEN RETURN 'bad_about'; END IF;

    -- A staff "hide" on the log blanks these words under the same lock, so
    -- the words read below cannot be written back over a hide.
    PERFORM pg_advisory_xact_lock(hashtext('adventure_persona:' || v_author.account_id));
    SELECT a.muted_until IS NOT NULL AND a.muted_until > now() INTO v_muted
      FROM public.account a WHERE a.id = v_author.account_id;
    IF v_muted THEN
        SELECT coalesce(pe.title, '') AS title, coalesce(pe.examine, '') AS examine,
               coalesce(pe.hangout, '') AS hangout, coalesce(pe.goals, '[]')::jsonb AS goals,
               coalesce(pr.about, '') AS about
          INTO v_old
          FROM (SELECT 1) one
          LEFT JOIN public.adventure_persona pe ON pe.account_id = v_author.account_id
          LEFT JOIN public.adventure_log_profile pr ON pr.account_id = v_author.account_id;
        IF (v_old.title, v_old.examine, v_old.hangout, v_old.goals, v_old.about)
           IS DISTINCT FROM (v_title, v_examine, v_hangout, v_goals, v_about) THEN
            RETURN 'muted';
        END IF;
    END IF;

    INSERT INTO public.adventure_persona (account_id, title, examine, hangout, goals, god, home_town, updated_at)
    VALUES (v_author.account_id, v_title, v_examine, v_hangout, v_goals::text, p_god, p_home, now())
    ON CONFLICT (account_id) DO UPDATE SET
        title = excluded.title, examine = excluded.examine, hangout = excluded.hangout,
        goals = excluded.goals, god = excluded.god, home_town = excluded.home_town,
        updated_at = excluded.updated_at;

    INSERT INTO public.adventure_log_profile (account_id, about, updated_at)
    VALUES (v_author.account_id, v_about, now())
    ON CONFLICT (account_id) DO UPDATE SET about = excluded.about, updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- Log settings > What your log shows: the kinds of adventure hidden (a bit
-- per adventure category, 0..255) and the parts of the log hidden (dialogue
-- 1, wardrobe 2, records 4, about 8, adventures 16; 0..31), saved together.
-- Both hide and neither says anything, so a mute does not matter.
-- 'ok' | 'not_found' | 'banned' | 'bad_mask'.
CREATE OR REPLACE FUNCTION accounts.adventure_log_save_shows(p_username text, p_categories int, p_parts int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    IF p_categories IS NULL OR p_categories NOT BETWEEN 0 AND 255
       OR p_parts IS NULL OR p_parts NOT BETWEEN 0 AND 31 THEN RETURN 'bad_mask'; END IF;

    INSERT INTO public.adventure_log_profile (account_id, hidden_categories, hidden_parts, updated_at)
    VALUES (v_author.account_id, p_categories, p_parts, now())
    ON CONFLICT (account_id) DO UPDATE
       SET hidden_categories = excluded.hidden_categories, hidden_parts = excluded.hidden_parts,
           updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- 200 characters: the posting functions, replaced in place (018)
-- ---------------------------------------------------------------------------

-- 'ok' with the new id | 'not_found' | 'banned' | 'muted' | 'bad_body' | 'rate_limited'.
CREATE OR REPLACE FUNCTION accounts.adventure_update_post(p_username text, p_body text)
RETURNS TABLE (result text, update_id int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_author record;
    v_body text := accounts.adventure_text(p_body, 200, false);
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

-- 'ok' | 'not_found' (no such shown update of theirs) | 'banned' | 'muted' |
-- 'bad_body'. The same text as before is 'ok' and changes nothing, edited_at
-- included - even over 200 characters, so an update posted before 018 can be
-- left as it is. Changed text must be 1..200 characters.
CREATE OR REPLACE FUNCTION accounts.adventure_update_edit(p_username text, p_update_id int, p_body text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_body text := accounts.adventure_text(p_body, 200, false);
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
    -- 2000 was the limit before 018: no stored update is longer
    IF accounts.adventure_text(p_body, 2000, false) = v_old THEN RETURN 'ok'; END IF;
    IF v_body IS NULL THEN RETURN 'bad_body'; END IF;

    UPDATE public.adventure_update SET body = v_body, edited_at = now() WHERE id = p_update_id;
    RETURN 'ok';
END;
$$;

-- 'ok' with the new id | 'not_found' (author, or no such shown update) |
-- 'banned' | 'muted' | 'blocked' | 'bad_body' | 'rate_limited'.
CREATE OR REPLACE FUNCTION accounts.adventure_reply_post(p_username text, p_update_id int, p_body text)
RETURNS TABLE (result text, reply_id int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_author record;
    v_body text := accounts.adventure_text(p_body, 200, false);
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

-- Post a notice. Words, so a mute stops it. Ten per clan a day, counting the
-- deleted ones, so deleting does not free a place. The newest twenty live
-- notices are kept and older ones deleted here, and so are deleted ones once
-- their day is over. The body is 1..200 characters (018).
-- 'ok' | 'not_found' | 'banned' | 'muted' | 'not_member' | 'forbidden' |
-- 'bad_title' | 'bad_body' | 'rate_limited'.
CREATE OR REPLACE FUNCTION accounts.clan_notice_post(p_username text, p_title text, p_body text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
    v_title text := accounts.adventure_text(p_title, 40, false);
    v_body text := accounts.adventure_text(p_body, 200, false);
BEGIN
    v_author := accounts.adventure_author(p_username, true);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    IF v_me.rank_level > (SELECT c.perm_page FROM public.adventure_clan c WHERE c.id = v_me.clan_id) THEN
        RETURN 'forbidden';
    END IF;

    IF v_title IS NULL OR position(E'\n' IN v_title) > 0 THEN RETURN 'bad_title'; END IF;
    IF v_body IS NULL THEN RETURN 'bad_body'; END IF;
    -- every notice made in the last day, deleted or not
    IF (SELECT count(*) FROM public.adventure_clan_notice n
         WHERE n.clan_id = v_me.clan_id AND n.created_at > now() - interval '1 day') >= 10 THEN
        RETURN 'rate_limited';
    END IF;

    INSERT INTO public.adventure_clan_notice (clan_id, author_account_id, title, body)
    VALUES (v_me.clan_id, v_author.account_id, v_title, v_body);
    -- Live notices past the newest twenty, and deleted ones that no longer
    -- count towards the day, go for good. Ten a day keeps every notice from
    -- the last day among the newest twenty.
    DELETE FROM public.adventure_clan_notice n
     WHERE n.clan_id = v_me.clan_id
       AND ((n.deleted_at IS NULL
             AND n.id NOT IN (SELECT k.id FROM public.adventure_clan_notice k
                               WHERE k.clan_id = v_me.clan_id AND k.deleted_at IS NULL
                               ORDER BY k.created_at DESC, k.id DESC
                               LIMIT 20))
            OR (n.deleted_at IS NOT NULL AND n.created_at <= now() - interval '1 day'));
    RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- staff_adventure_reports and staff_adventure_resolve, replaced in place (018)
-- ---------------------------------------------------------------------------

-- Reports for staff, open ones first then the newest, at most 200. `content`
-- is what was reported as it stands: the update or reply; for a log, its
-- greeting (page 1's first line, which took the headline's place in 018), a
-- blank line and its About (its CSS is `css`); and for a clan its motto and
-- About, with `log_owner` the clan's name and `author` its Leader.
-- `content_state` says whether it is still shown; a clan that has been
-- disbanded is 'deleted'. Nothing for a caller who is not staff.
CREATE OR REPLACE FUNCTION accounts.staff_adventure_reports(p_actor text, p_open_only boolean)
RETURNS TABLE (id int, target_kind text, target_id int, log_owner text, author text, reporter text,
               reason text, created_at timestamptz, content text, css text, content_state text,
               resolved_at timestamptz, resolution text, resolved_by text, note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.id, r.target_kind, r.target_id,
           coalesce(uo.username, ro.username, lo.username, c.name),
           coalesce(uo.username, ra.username, lo.username, cl.username),
           rep.username, r.reason, r.created_at,
           coalesce(u.body, rr.body,
                    CASE WHEN lo.id IS NOT NULL THEN lg.greeting || E'\n\n' || coalesce(lp.about, '') END,
                    CASE WHEN c.id IS NOT NULL THEN c.motto || E'\n' || c.about END),
           CASE WHEN r.target_kind = 'log' THEN coalesce(lp.custom_css, '') END,
           CASE
               WHEN r.target_kind = 'update' THEN CASE WHEN u.deleted_at IS NOT NULL THEN 'deleted' WHEN u.staff_hidden_at IS NOT NULL THEN 'hidden' ELSE 'shown' END
               WHEN r.target_kind = 'reply' THEN CASE WHEN rr.deleted_at IS NOT NULL THEN 'deleted' WHEN rr.staff_hidden_at IS NOT NULL THEN 'hidden' ELSE 'shown' END
               WHEN r.target_kind = 'clan' THEN CASE WHEN c.id IS NULL THEN 'deleted' ELSE 'shown' END
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
      LEFT JOIN public.adventure_persona lpe ON lpe.account_id = lo.id
      LEFT JOIN LATERAL accounts.adventure_greeting(lpe.dialogue::jsonb) lg ON true
      LEFT JOIN public.adventure_clan c ON r.target_kind = 'clan' AND c.id = r.target_id
      LEFT JOIN public.adventure_clan_member cm ON cm.clan_id = c.id AND cm.rank = 'leader'
      LEFT JOIN public.account cl ON cl.id = cm.account_id
      LEFT JOIN public.account res ON res.id = r.resolved_by_account_id
     WHERE accounts.is_staff(p_actor)
       AND (NOT coalesce(p_open_only, false) OR r.resolved_at IS NULL)
     ORDER BY (r.resolved_at IS NULL) DESC, r.created_at DESC, r.id DESC
     LIMIT 200;
$$;

-- 'ok' | 'forbidden' | 'bad_credentials' | 'rate_limited' | 'not_found' | 'invalid'.
--
-- p_action is 'hide' (the update or reply; for a log, its About and persona
-- words are cleared - the dialogue, and with it the greeting (018); for a
-- clan, its motto and About are cleared, its notices deleted (marked) and it
-- is renamed 'Clan <id>'), 'disable_css' (a log only) or 'dismiss'. The typed
-- password is checked the way staff_report_resolve checks it, in the same
-- limiter.
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
        ELSIF v_report.target_kind = 'clan' THEN
            -- the clan's lock, which every clan write takes first
            PERFORM pg_advisory_xact_lock(hashtext('clan:' || v_report.target_id));
            UPDATE public.adventure_clan SET name = 'Clan ' || v_report.target_id, slug = 'clan-' || v_report.target_id, motto = '', about = '', updated_at = now() WHERE id = v_report.target_id;
            -- marked, so they still count towards the clan's ten a day
            UPDATE public.adventure_clan_notice SET deleted_at = now() WHERE clan_id = v_report.target_id AND deleted_at IS NULL;
        ELSE
            -- the persona's lock, which a save of its words takes first (017)
            PERFORM pg_advisory_xact_lock(hashtext('adventure_persona:' || v_report.target_id));
            UPDATE public.adventure_log_profile SET about = '', updated_at = now() WHERE account_id = v_report.target_id;
            UPDATE public.adventure_persona SET title = '', examine = '', hangout = '', goals = '[]', dialogue = '[]', updated_at = now() WHERE account_id = v_report.target_id;
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
-- Six grants: adventure_log, adventure_log_directory and adventure_persona
-- again (dropped and made anew above), and the two persona writers and
-- adventure_log_save_shows, which are new. With adventure_log_save,
-- adventure_log_set_hidden and the old two persona writers gone, that takes
-- the `website` role from one hundred and eight to one hundred and seven.
-- adventure_greeting is granted to nobody; the functions replaced in place
-- keep their grants. Still no privilege of any kind on schema public.

REVOKE ALL ON FUNCTION accounts.adventure_greeting(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log_directory(timestamptz, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona_save_words(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona_save_sheet(text, text, text, text, jsonb, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_log_save_shows(text, int, int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.adventure_log(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_log_directory(timestamptz, text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_persona(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_persona_save_words(text, text, jsonb) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_persona_save_sheet(text, text, text, text, jsonb, text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_log_save_shows(text, int, int) TO website;

-- rollback:
--
-- Forward only once Website W4 (feat/pages-speak) is live: W4 and every later
-- Website PR read 018's shapes (the greeting columns, hidden_parts, pages with
-- a colour and effect, and the new writers). Before that, roll the Website
-- back to its state before W4 FIRST, then run what follows. Take a dump
-- before applying 018: the headlines it dropped (over 60 characters, or on a
-- log with five pages already) are only in that dump. The moved headlines stay
-- as page 1 of their dialogue, and older posts over 200 characters stay.
--
-- Run the statements below: they drop the new functions, take the colour and
-- effect off every page, and put the columns and their checks back (empty
-- headlines, yellow and no effect). The body checks were never changed. Then
-- re-run the CREATE OR REPLACE blocks, with their REVOKE and GRANT lines, of
-- adventure_log, adventure_log_save, adventure_log_set_hidden,
-- adventure_update_post and adventure_reply_post from 013_adventurer_log
-- (adventure_log_save as 016_adventure_persona has it);
-- adventure_log_directory from 014_adventure_directory; adventure_update_edit
-- from 015_adventure_timeline_v2; adventure_dialogue from
-- 016_adventure_persona; and adventure_persona, the two persona writers,
-- clan_notice_post, staff_adventure_reports and staff_adventure_resolve from
-- 017_adventure_clans.
--
-- DROP FUNCTION IF EXISTS accounts.adventure_log_save_shows(text, int, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona_save_sheet(text, text, text, text, jsonb, text, text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona_save_words(text, text, jsonb);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona(text);
-- DROP FUNCTION IF EXISTS accounts.adventure_log_directory(timestamptz, text, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_log(text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_greeting(jsonb);
-- UPDATE "adventure_persona" SET "dialogue" = (SELECT coalesce(jsonb_agg(t.page - 'colour' - 'effect' ORDER BY t.n), '[]'::jsonb) FROM jsonb_array_elements("dialogue"::jsonb) WITH ORDINALITY AS t(page, n))::text;
-- ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "headline_colour" SMALLINT NOT NULL DEFAULT 0;
-- ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "headline_effect" SMALLINT NOT NULL DEFAULT 0;
-- ALTER TABLE "adventure_persona" ADD CONSTRAINT "adventure_persona_colour" CHECK ("headline_colour" BETWEEN 0 AND 11);
-- ALTER TABLE "adventure_persona" ADD CONSTRAINT "adventure_persona_effect" CHECK ("headline_effect" BETWEEN 0 AND 2);
-- ALTER TABLE "adventure_log_profile" DROP CONSTRAINT IF EXISTS "adventure_log_profile_parts";
-- ALTER TABLE "adventure_log_profile" DROP COLUMN IF EXISTS "hidden_parts";
-- ALTER TABLE "adventure_log_profile" ADD COLUMN IF NOT EXISTS "headline" TEXT NOT NULL DEFAULT '';
-- ALTER TABLE "adventure_log_profile" ADD CONSTRAINT "adventure_log_profile_headline" CHECK (length("headline") <= 80);
