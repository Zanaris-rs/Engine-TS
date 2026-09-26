-- 016_adventure_persona: an adventurer's persona on their log.
--
-- Sprint 4 of the Adventurer Log. The owner crafts who their 2004 adventurer
-- is: a colour and effect for the headline (drawn as overhead chat), a
-- title, an examine line, a home town, a hangout, a god, a clan, a playstyle,
-- up to three goals, a scene to stand in, a signature emote, and up to five
-- pages of NPC-style dialogue, each with a chathead mood and an emote.
--
-- One table and seven functions: two the website calls, five helpers it may
-- not. adventure_log_save and staff_adventure_resolve are replaced in place,
-- same signatures (so the live site keeps working mid-rollout):
--
-- - adventure_log_save: a NULL headline keeps the stored one, so "About you"
--   can save without the headline, which now lives on the Character tab.
-- - staff_adventure_resolve: "hide" on a log also blanks the persona's words.
--
-- Rules, as in 013:
--
-- - **Words** (headline, title, examine, hangout, clan, goals, dialogue lines)
--   go through adventure_text: trimmed, no control characters, one line.
-- - **Picks** (colour, effect, god, home town, playstyle, scene, emotes,
--   moods) are fixed lists here, or for the three place/style keys only a
--   shape: the website owns those lists and ignores keys it does not know,
--   so adding a place is a website change.
-- - **A mute** stops new words, not new picks - as gz stays open to a muted
--   player because it is not text.
-- - JSON lives in TEXT columns, like adventure_outfit.kits, so the MySQL and
--   SQLite schemas can hold it; the functions cast.
--
-- Nothing the game server reads or writes changes: no fleet deploy. The
-- `website` role goes from eighty-four functions to eighty-six.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "adventure_persona" (
    "account_id" INTEGER NOT NULL,
    "headline_colour" SMALLINT NOT NULL DEFAULT 0,
    "headline_effect" SMALLINT NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL DEFAULT '',
    "examine" TEXT NOT NULL DEFAULT '',
    "hangout" TEXT NOT NULL DEFAULT '',
    "clan" TEXT NOT NULL DEFAULT '',
    "goals" TEXT NOT NULL DEFAULT '[]',
    "god" TEXT,
    "home_town" TEXT,
    "playstyle" TEXT,
    "scene" TEXT,
    "signature_emote" TEXT,
    "dialogue" TEXT NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_persona_pkey" PRIMARY KEY ("account_id"),
    CONSTRAINT "adventure_persona_colour" CHECK ("headline_colour" BETWEEN 0 AND 11),
    CONSTRAINT "adventure_persona_effect" CHECK ("headline_effect" BETWEEN 0 AND 2),
    CONSTRAINT "adventure_persona_title" CHECK (length("title") <= 24),
    CONSTRAINT "adventure_persona_examine" CHECK (length("examine") <= 80),
    CONSTRAINT "adventure_persona_hangout" CHECK (length("hangout") <= 40),
    CONSTRAINT "adventure_persona_clan" CHECK (length("clan") <= 24),
    CONSTRAINT "adventure_persona_god" CHECK ("god" IN ('saradomin', 'zamorak', 'guthix')),
    CONSTRAINT "adventure_persona_keys" CHECK (
        ("home_town" IS NULL OR "home_town" ~ '^[a-z_]{1,24}$') AND
        ("playstyle" IS NULL OR "playstyle" ~ '^[a-z_]{1,24}$') AND
        ("scene" IS NULL OR "scene" ~ '^[a-z_]{1,24}$')),
    CONSTRAINT "adventure_persona_emote" CHECK ("signature_emote" IN ('yes', 'no', 'think', 'bow', 'angry', 'cry', 'laugh', 'cheer', 'wave', 'beckon', 'clap', 'dance')),
    CONSTRAINT "adventure_persona_json" CHECK (length("goals") <= 400 AND length("dialogue") <= 4000)
);

ALTER TABLE "adventure_persona" ENABLE ROW LEVEL SECURITY;

-- === functions ===

-- Revision 274's emote tab, less the four mime emotes whose frames the cache
-- does not have. The site's list is the same (lib/chathead/vocab.ts).
CREATE OR REPLACE FUNCTION accounts.adventure_emotes() RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT ARRAY['yes', 'no', 'think', 'bow', 'angry', 'cry', 'laugh', 'cheer', 'wave', 'beckon', 'clap', 'dance']
$$;

-- The chathead moods: content's human.mesanim, less 'short' and 'idle'.
CREATE OR REPLACE FUNCTION accounts.adventure_moods() RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT ARRAY['neutral', 'happy', 'sad', 'angry', 'verymad', 'laugh', 'evillaugh', 'shock', 'confused', 'bored', 'shifty', 'scared', 'drunk', 'quiz']
$$;

-- Goals as stored: a JSON array of up to three trimmed one-line strings of
-- 1..40 characters, or NULL for anything else.
CREATE OR REPLACE FUNCTION accounts.adventure_goals(p_goals jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_item jsonb;
    v_text text;
    v_out jsonb := '[]'::jsonb;
BEGIN
    IF p_goals IS NULL OR jsonb_typeof(p_goals) <> 'array' OR jsonb_array_length(p_goals) > 3 THEN
        RETURN NULL;
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_goals) LOOP
        IF jsonb_typeof(v_item) <> 'string' THEN RETURN NULL; END IF;
        v_text := accounts.adventure_text(v_item #>> '{}', 40, false);
        IF v_text IS NULL OR position(E'\n' IN v_text) > 0 THEN RETURN NULL; END IF;
        v_out := v_out || to_jsonb(v_text);
    END LOOP;
    RETURN v_out;
END;
$$;

-- Dialogue as stored: up to five pages of {mood, emote, lines}, each line a
-- trimmed one-line string of 1..60 characters, one to four lines a page, no
-- other keys; a missing emote is null. NULL for anything else.
CREATE OR REPLACE FUNCTION accounts.adventure_dialogue(p_dialogue jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_page jsonb;
    v_line jsonb;
    v_lines jsonb;
    v_text text;
    v_out jsonb := '[]'::jsonb;
BEGIN
    IF p_dialogue IS NULL OR jsonb_typeof(p_dialogue) <> 'array' OR jsonb_array_length(p_dialogue) > 5 THEN
        RETURN NULL;
    END IF;
    FOR v_page IN SELECT value FROM jsonb_array_elements(p_dialogue) LOOP
        IF jsonb_typeof(v_page) <> 'object'
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_page) k WHERE k NOT IN ('mood', 'emote', 'lines'))
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
            'lines', v_lines));
    END LOOP;
    RETURN v_out;
END;
$$;

-- Every word a persona puts on a public page, in one comparable value: what
-- a mute may not change.
CREATE OR REPLACE FUNCTION accounts.adventure_persona_words(p_headline text, p_title text, p_examine text,
                                                            p_hangout text, p_clan text, p_goals jsonb, p_dialogue jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT jsonb_build_array(p_headline, p_title, p_examine, p_hangout, p_clan, p_goals,
        (SELECT coalesce(jsonb_agg(page -> 'lines' ORDER BY n), '[]'::jsonb)
           FROM jsonb_array_elements(p_dialogue) WITH ORDINALITY AS t(page, n)))
$$;

-- A log's persona, for anyone: zero rows for no account, a banned one, or a
-- persona never saved.
CREATE OR REPLACE FUNCTION accounts.adventure_persona(p_name text)
RETURNS TABLE (headline_colour int, headline_effect int, title text, examine text, hangout text, clan text,
               goals jsonb, god text, home_town text, playstyle text, scene text, signature_emote text,
               dialogue jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT pe.headline_colour::int, pe.headline_effect::int, pe.title, pe.examine, pe.hangout, pe.clan,
           pe.goals::jsonb, pe.god, pe.home_town, pe.playstyle, pe.scene, pe.signature_emote,
           pe.dialogue::jsonb
      FROM public.account a
      JOIN public.adventure_persona pe ON pe.account_id = a.id
     WHERE a.username = p_name
       AND (a.banned_until IS NULL OR a.banned_until <= now());
$$;

-- The Character tab's one Save: the headline (on adventure_log_profile, where
-- the directory and link previews read it) and the persona, together.
-- 'ok' | 'not_found' | 'banned' | 'muted' | 'bad_headline' | 'bad_title' |
-- 'bad_examine' | 'bad_hangout' | 'bad_clan' | 'bad_goals' | 'bad_god' |
-- 'bad_key' | 'bad_emote' | 'bad_dialogue'.
CREATE OR REPLACE FUNCTION accounts.adventure_persona_save(
    p_username text, p_headline text, p_colour int, p_effect int,
    p_title text, p_examine text, p_hangout text, p_clan text, p_goals jsonb,
    p_god text, p_home text, p_style text, p_scene text, p_emote text, p_dialogue jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_muted boolean;
    v_old record;
    v_headline text := accounts.adventure_text(p_headline, 80, true);
    v_title text := accounts.adventure_text(p_title, 24, true);
    v_examine text := accounts.adventure_text(p_examine, 80, true);
    v_hangout text := accounts.adventure_text(p_hangout, 40, true);
    v_clan text := accounts.adventure_text(p_clan, 24, true);
    v_goals jsonb := accounts.adventure_goals(p_goals);
    v_dialogue jsonb := accounts.adventure_dialogue(p_dialogue);
BEGIN
    -- Not "speaking": a mute is checked below, against words only.
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF v_headline IS NULL OR position(E'\n' IN v_headline) > 0
       OR p_colour IS NULL OR p_colour NOT BETWEEN 0 AND 11
       OR p_effect IS NULL OR p_effect NOT BETWEEN 0 AND 2 THEN RETURN 'bad_headline'; END IF;
    IF v_title IS NULL OR position(E'\n' IN v_title) > 0 THEN RETURN 'bad_title'; END IF;
    IF v_examine IS NULL OR position(E'\n' IN v_examine) > 0 THEN RETURN 'bad_examine'; END IF;
    IF v_hangout IS NULL OR position(E'\n' IN v_hangout) > 0 THEN RETURN 'bad_hangout'; END IF;
    IF v_clan IS NULL OR position(E'\n' IN v_clan) > 0 THEN RETURN 'bad_clan'; END IF;
    IF v_goals IS NULL THEN RETURN 'bad_goals'; END IF;
    IF p_god IS NOT NULL AND p_god NOT IN ('saradomin', 'zamorak', 'guthix') THEN RETURN 'bad_god'; END IF;
    IF (p_home IS NOT NULL AND p_home !~ '^[a-z_]{1,24}$')
       OR (p_style IS NOT NULL AND p_style !~ '^[a-z_]{1,24}$')
       OR (p_scene IS NOT NULL AND p_scene !~ '^[a-z_]{1,24}$') THEN RETURN 'bad_key'; END IF;
    IF p_emote IS NOT NULL AND NOT (p_emote = ANY (accounts.adventure_emotes())) THEN RETURN 'bad_emote'; END IF;
    IF v_dialogue IS NULL THEN RETURN 'bad_dialogue'; END IF;

    SELECT a.muted_until IS NOT NULL AND a.muted_until > now() INTO v_muted
      FROM public.account a WHERE a.id = v_author.account_id;
    IF v_muted THEN
        SELECT coalesce(pr.headline, '') AS headline, coalesce(pe.title, '') AS title,
               coalesce(pe.examine, '') AS examine, coalesce(pe.hangout, '') AS hangout,
               coalesce(pe.clan, '') AS clan, coalesce(pe.goals, '[]')::jsonb AS goals,
               coalesce(pe.dialogue, '[]')::jsonb AS dialogue
          INTO v_old
          FROM (SELECT 1) one
          LEFT JOIN public.adventure_log_profile pr ON pr.account_id = v_author.account_id
          LEFT JOIN public.adventure_persona pe ON pe.account_id = v_author.account_id;
        IF accounts.adventure_persona_words(v_old.headline, v_old.title, v_old.examine, v_old.hangout,
                                            v_old.clan, v_old.goals, v_old.dialogue)
           IS DISTINCT FROM
           accounts.adventure_persona_words(v_headline, v_title, v_examine, v_hangout,
                                            v_clan, v_goals, v_dialogue) THEN
            RETURN 'muted';
        END IF;
    END IF;

    INSERT INTO public.adventure_log_profile (account_id, headline, updated_at)
    VALUES (v_author.account_id, v_headline, now())
    ON CONFLICT (account_id) DO UPDATE SET headline = excluded.headline, updated_at = excluded.updated_at;

    INSERT INTO public.adventure_persona (account_id, headline_colour, headline_effect, title, examine,
                                          hangout, clan, goals, god, home_town, playstyle, scene,
                                          signature_emote, dialogue, updated_at)
    VALUES (v_author.account_id, p_colour, p_effect, v_title, v_examine, v_hangout, v_clan,
            v_goals::text, p_god, p_home, p_style, p_scene, p_emote, v_dialogue::text, now())
    ON CONFLICT (account_id) DO UPDATE SET
        headline_colour = excluded.headline_colour, headline_effect = excluded.headline_effect,
        title = excluded.title, examine = excluded.examine, hangout = excluded.hangout,
        clan = excluded.clan, goals = excluded.goals, god = excluded.god,
        home_town = excluded.home_town, playstyle = excluded.playstyle, scene = excluded.scene,
        signature_emote = excluded.signature_emote, dialogue = excluded.dialogue,
        updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- adventure_log_save and staff_adventure_resolve, replaced in place (016)
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

    -- a headline is one line; NULL keeps the stored one (016)
    IF p_headline IS NOT NULL AND (v_headline IS NULL OR position(E'\n' IN v_headline) > 0) THEN RETURN 'bad_headline'; END IF;
    IF v_about IS NULL THEN RETURN 'bad_about'; END IF;

    INSERT INTO public.adventure_log_profile (account_id, headline, about, updated_at)
    VALUES (v_author.account_id, coalesce(v_headline, ''), v_about, now())
    ON CONFLICT (account_id) DO UPDATE
       SET headline = CASE WHEN p_headline IS NULL THEN adventure_log_profile.headline ELSE excluded.headline END,
           about = excluded.about, updated_at = excluded.updated_at;
    RETURN 'ok';
END;
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
            UPDATE public.adventure_persona SET title = '', examine = '', hangout = '', clan = '', goals = '[]', dialogue = '[]', updated_at = now() WHERE account_id = v_report.target_id;
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
-- Two more functions on the `website` role, taking it to eighty-six; the five
-- helpers are granted to nobody; adventure_log_save and staff_adventure_resolve
-- keep their existing grants from 013. Still no privilege of any kind on
-- schema public.

REVOKE ALL ON FUNCTION accounts.adventure_emotes() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_moods() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_goals(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_dialogue(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona_words(text, text, text, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona_save(text, text, int, int, text, text, text, text, jsonb, text, text, text, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.adventure_persona(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_persona_save(text, text, int, int, text, text, text, text, jsonb, text, text, text, text, text, jsonb) TO website;

-- rollback:
--
-- Drops every persona. adventure_log_save and staff_adventure_resolve go back
-- to 013_adventurer_log's definitions: re-run those two CREATE OR REPLACE
-- blocks from that file. Take a dump first.
--
-- DROP FUNCTION IF EXISTS accounts.adventure_persona_save(text, text, int, int, text, text, text, text, jsonb, text, text, text, text, text, jsonb);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona(text);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona_words(text, text, text, text, text, jsonb, jsonb);
-- DROP FUNCTION IF EXISTS accounts.adventure_dialogue(jsonb);
-- DROP FUNCTION IF EXISTS accounts.adventure_goals(jsonb);
-- DROP FUNCTION IF EXISTS accounts.adventure_moods();
-- DROP FUNCTION IF EXISTS accounts.adventure_emotes();
-- DROP TABLE IF EXISTS "adventure_persona";
