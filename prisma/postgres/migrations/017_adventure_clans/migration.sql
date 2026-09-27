-- 017_adventure_clans: clans, and the persona saved one tab at a time.
--
-- Sprint 5 of the Adventurer Log. Players can start a clan, invite others
-- into it and give them ranks; the persona loses its free-text clan and its
-- playstyle, gains the way the figure faces, and is saved by three writers,
-- one per Character tab, so one tab cannot overwrite another.
--
-- Four new tables; adventure_persona loses two columns and gains one, and
-- adventure_report's kinds gain 'clan'. Nothing the game server reads or
-- writes changes, so there is no fleet deploy. The `website` role goes from
-- eighty-six functions to one hundred and eight.
--
-- ## Clans
--
-- - **Joining** is by invite only, one clan at a time: the member table is
--   keyed by account. Accepting an invite deletes that invite only; invites
--   from other clans stay, and cannot be accepted while in a clan. Invites
--   do not expire. A new member is a Recruit.
-- - **Ranks** are the clan-chat ladder, stored by name and compared by level:
--   leader 0, general 1, captain 2, lieutenant 3, sergeant 4, corporal 5,
--   recruit 6. A rank outranks another when its level is lower. One Leader
--   per clan is a partial unique index.
-- - **"Who can..."** is four thresholds the Leader sets - invite, remove,
--   change ranks, post notices and edit the page - each a level: members
--   whose rank's level is at most the threshold may (0 the Leader only, 6
--   every member). Defaults 4, 1, 1 and 2.
-- - **Acting on members:** only on members you outrank, and only giving ranks
--   below your own; the Leader can make Generals. The key moves only by
--   hand-over: the new Leader takes it and the old one becomes a General.
-- - **Leaving:** the Leader cannot leave while anyone else is in the clan,
--   banned members included; they hand over or disband. A Leader who is the
--   last member may leave, which disbands the clan. Disbanding deletes the
--   clan, its members, its invites and its notices.
-- - **Limits:** 50 members, the Leader included; 20 pending invites; the
--   newest 20 notices kept, older ones deleted on insert; 10 notices per clan
--   per day, counting deleted ones. Deleting a notice (or a staff "hide")
--   only marks it (deleted_at), so it keeps its place in the day and cannot
--   be posted, deleted and posted again; a marked notice is removed for good
--   by the first post after its day is over.
-- - **Names** are 1..20 letters, digits and single spaces, starting and
--   ending with a letter or digit, checked as given (not trimmed). The slug
--   is the name lower-cased with each space a '-', unique, so two names that
--   differ only in case collide ('taken'). 'Clan <number>' in any case is
--   kept for staff renames. Renaming changes the slug; the old one 404s.
-- - **Words** - the name, motto (up to 80, one line), About (up to 600) and
--   notices (a title of 1..40 on one line, a body of 1..280) - go through
--   adventure_text, as in 013.
-- - **Picks** - the crest (any item id, 0..65535; the website decides which
--   items make a crest), the world (1..255 or NULL; the website owns the
--   list), ranks, thresholds, invites and answers - are not words.
-- - **A mute** stops words, not picks, as it does for the persona in 016: a
--   muted player cannot start a clan (its name is words) or post a notice,
--   and saving the clan page is refused only when the name, motto or About
--   would change.
-- - **A ban** stops every write, and a banned player is left out of every
--   public read: the roster, the member counts, the directory, the notices
--   they wrote and a clan's Leader, which reads NULL while the Leader is
--   banned. A banned Leader keeps the key; staff can step in.
-- - **Locks.** Every clan write takes an advisory lock on the caller's clan
--   (clan_membership) and reads the caller's rank again under it, so a rank
--   cannot change between the check and the write. A staff "hide" on a clan
--   takes the same lock. Starting a clan locks the account; accepting an
--   invite locks the clan and then the account. Nothing takes them in the
--   other order.
-- - **Target names** are found the way adventure_block finds one: the exact
--   username. An invite to an unknown or banned name is 'no_such_player'; a
--   hand-over to a banned member is 'no_such_member'.
-- - **Reports** gain the kind 'clan', whose target id is the clan's id. A
--   member reporting their own clan is 'self'. A staff "hide" on a clan
--   blanks the motto and About, deletes (marks) the notices and renames the
--   clan 'Clan <id>' (slug 'clan-<id>'). Staff can mute the author as usual.
--
-- ## The persona
--
-- - clan and playstyle are dropped (their data is not kept: only testers have
--   used them), and so is the playstyle part of the keys check.
-- - facing, 0..15, is the way the figure faces when someone opens the log,
--   in 16 steps of 128 yaw units from today's angle (0).
-- - adventure_persona is dropped and made anew, because its columns change.
-- - adventure_persona_save and adventure_persona_words are dropped. Three
--   writers replace the save, one per tab, each making the row on first save:
--   save_words (headline, colour, effect, signature emote, dialogue),
--   save_sheet (title, examine, hangout, goals, god, home town) and
--   save_stage (scene, facing). A mute refuses save_words when the headline
--   or the dialogue's lines (in order, as one list) would change, and
--   save_sheet when the title, examine, hangout or a goal would; save_stage
--   is picks only. save_words and save_sheet take a lock on the account's
--   persona before they read the old words, and a staff "hide" on a log
--   takes it before it blanks them, so a muted save cannot read the words
--   before a hide and write them back after it.
--
-- adventure_report, staff_adventure_reports and staff_adventure_resolve are
-- replaced in place, same signatures, keeping their grants: reports cover
-- clans, and "hide" on a log no longer mentions the clan column.
--
-- No foreign keys, like every other table.

-- ---------------------------------------------------------------------------
-- the persona: the old save goes, clan and playstyle go, facing comes
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS accounts.adventure_persona_save(text, text, int, int, text, text, text, text, jsonb, text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS accounts.adventure_persona_words(text, text, text, text, text, jsonb, jsonb);
-- Its result columns change, which CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS accounts.adventure_persona(text);

ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_keys";
ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_clan";
ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "clan";
ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "playstyle";
ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "facing" SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_facing";
ALTER TABLE "adventure_persona" ADD CONSTRAINT "adventure_persona_facing" CHECK ("facing" BETWEEN 0 AND 15);
ALTER TABLE "adventure_persona" ADD CONSTRAINT "adventure_persona_keys" CHECK (
    ("home_town" IS NULL OR "home_town" ~ '^[a-z_]{1,24}$') AND
    ("scene" IS NULL OR "scene" ~ '^[a-z_]{1,24}$'));

-- ---------------------------------------------------------------------------
-- reports: a clan is a kind of target
-- ---------------------------------------------------------------------------

ALTER TABLE "adventure_report" DROP CONSTRAINT IF EXISTS "adventure_report_kind";
ALTER TABLE "adventure_report" ADD CONSTRAINT "adventure_report_kind" CHECK ("target_kind" IN ('update', 'reply', 'log', 'clan'));

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "adventure_clan" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "motto" TEXT NOT NULL DEFAULT '',
    "crest" INTEGER NOT NULL,
    "world" SMALLINT,
    "about" TEXT NOT NULL DEFAULT '',
    "perm_invite" SMALLINT NOT NULL DEFAULT 4,
    "perm_remove" SMALLINT NOT NULL DEFAULT 1,
    "perm_ranks" SMALLINT NOT NULL DEFAULT 1,
    "perm_page" SMALLINT NOT NULL DEFAULT 2,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_clan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "adventure_clan_name" CHECK ("name" ~ '^[A-Za-z0-9]( ?[A-Za-z0-9])*$' AND length("name") BETWEEN 1 AND 20),
    CONSTRAINT "adventure_clan_slug" CHECK ("slug" = replace(lower("name"), ' ', '-')),
    CONSTRAINT "adventure_clan_motto" CHECK (length("motto") <= 80 AND position(E'\n' IN "motto") = 0),
    CONSTRAINT "adventure_clan_crest" CHECK ("crest" BETWEEN 0 AND 65535),
    CONSTRAINT "adventure_clan_world" CHECK ("world" BETWEEN 1 AND 255),
    CONSTRAINT "adventure_clan_about" CHECK (length("about") <= 600),
    CONSTRAINT "adventure_clan_perms" CHECK ("perm_invite" BETWEEN 0 AND 6 AND "perm_remove" BETWEEN 0 AND 6 AND "perm_ranks" BETWEEN 0 AND 6 AND "perm_page" BETWEEN 0 AND 6)
);

CREATE TABLE IF NOT EXISTS "adventure_clan_member" (
    "account_id" INTEGER NOT NULL,
    "clan_id" INTEGER NOT NULL,
    "rank" TEXT NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_clan_member_pkey" PRIMARY KEY ("account_id"),
    CONSTRAINT "adventure_clan_member_rank" CHECK ("rank" IN ('leader', 'general', 'captain', 'lieutenant', 'sergeant', 'corporal', 'recruit'))
);

CREATE TABLE IF NOT EXISTS "adventure_clan_invite" (
    "clan_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "invited_by_account_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_clan_invite_pkey" PRIMARY KEY ("clan_id", "account_id")
);

CREATE TABLE IF NOT EXISTS "adventure_clan_notice" (
    "id" SERIAL NOT NULL,
    "clan_id" INTEGER NOT NULL,
    "author_account_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "adventure_clan_notice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "adventure_clan_notice_title" CHECK (length("title") BETWEEN 1 AND 40 AND position(E'\n' IN "title") = 0),
    CONSTRAINT "adventure_clan_notice_body" CHECK (length("body") BETWEEN 1 AND 280)
);

CREATE UNIQUE INDEX IF NOT EXISTS "adventure_clan_slug_key" ON "adventure_clan"("slug");
CREATE INDEX IF NOT EXISTS "adventure_clan_member_clan_id_idx" ON "adventure_clan_member"("clan_id");
-- One Leader per clan. Postgres only - Prisma cannot say "partial", and
-- nothing else runs these functions.
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_clan_member_one_leader_key" ON "adventure_clan_member"("clan_id") WHERE "rank" = 'leader';
CREATE INDEX IF NOT EXISTS "adventure_clan_invite_account_id_idx" ON "adventure_clan_invite"("account_id");
CREATE INDEX IF NOT EXISTS "adventure_clan_notice_clan_id_created_at_idx" ON "adventure_clan_notice"("clan_id", "created_at");

ALTER TABLE "adventure_clan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "adventure_clan_member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "adventure_clan_invite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "adventure_clan_notice" ENABLE ROW LEVEL SECURITY;

-- === functions ===

-- ---------------------------------------------------------------------------
-- internal helpers: NOT granted to website
-- ---------------------------------------------------------------------------

-- The clan-chat ladder, top to bottom: a rank's level is its place here, 0
-- for the Leader; NULL for anything else. The site's list is the same
-- (lib/clans/ranks.ts).
CREATE OR REPLACE FUNCTION accounts.clan_rank_level(p_rank text) RETURNS int
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT array_position(ARRAY['leader', 'general', 'captain', 'lieutenant', 'sergeant', 'corporal', 'recruit'], p_rank) - 1
$$;

-- A clan's URL slug: the name lower-cased, each space a '-'.
CREATE OR REPLACE FUNCTION accounts.clan_slug(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT replace(lower(p_name), ' ', '-')
$$;

-- A name a player may choose: 1..20 letters, digits and single spaces,
-- starting and ending with a letter or digit, and not 'Clan <number>' in any
-- case - staff renames use that.
CREATE OR REPLACE FUNCTION accounts.clan_name_ok(p_name text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT coalesce(length(p_name) BETWEEN 1 AND 20
                    AND p_name ~ '^[A-Za-z0-9]( ?[A-Za-z0-9])*$'
                    AND lower(p_name) !~ '^clan [0-9]+$', false)
$$;

-- The caller's clan, rank and rank level, with that clan's advisory lock
-- held. Every clan write that acts on the caller's own clan starts here, so
-- nothing it reads about the caller changes before it commits. All NULL for
-- someone in no clan - including someone who left between the first read and
-- the lock.
CREATE OR REPLACE FUNCTION accounts.clan_membership(p_account_id int, OUT clan_id int, OUT rank text, OUT rank_level int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_clan int;
BEGIN
    SELECT m.clan_id INTO v_clan FROM public.adventure_clan_member m WHERE m.account_id = p_account_id;
    IF v_clan IS NULL THEN RETURN; END IF;

    PERFORM pg_advisory_xact_lock(hashtext('clan:' || v_clan));
    SELECT m.clan_id, m.rank INTO clan_id, rank
      FROM public.adventure_clan_member m
     WHERE m.account_id = p_account_id AND m.clan_id = v_clan;
    rank_level := accounts.clan_rank_level(rank);
END;
$$;

-- A dialogue's lines, in order, as one flat JSON array: what a mute may not
-- change. Moods and emotes are picks and are not in it.
CREATE OR REPLACE FUNCTION accounts.adventure_dialogue_lines(p_dialogue jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT coalesce(jsonb_agg(l.line ORDER BY p.page_n, l.line_n), '[]'::jsonb)
      FROM jsonb_array_elements(p_dialogue) WITH ORDINALITY AS p(page, page_n),
           jsonb_array_elements(p.page -> 'lines') WITH ORDINALITY AS l(line, line_n)
$$;

-- ---------------------------------------------------------------------------
-- the persona
-- ---------------------------------------------------------------------------

-- A log's persona, for anyone: zero rows for no account, a banned one, or a
-- persona never saved.
CREATE OR REPLACE FUNCTION accounts.adventure_persona(p_name text)
RETURNS TABLE (headline_colour int, headline_effect int, title text, examine text, hangout text,
               goals jsonb, god text, home_town text, scene text, facing int, signature_emote text,
               dialogue jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT pe.headline_colour::int, pe.headline_effect::int, pe.title, pe.examine, pe.hangout,
           pe.goals::jsonb, pe.god, pe.home_town, pe.scene, pe.facing::int, pe.signature_emote,
           pe.dialogue::jsonb
      FROM public.account a
      JOIN public.adventure_persona pe ON pe.account_id = a.id
     WHERE a.username = p_name
       AND (a.banned_until IS NULL OR a.banned_until <= now());
$$;

-- Character > Words: the headline (on adventure_log_profile, where the
-- directory and link previews read it), its colour and effect, the signature
-- emote and the dialogue. Makes the persona row on first save; touches
-- nothing the other two tabs save.
-- 'ok' | 'not_found' | 'banned' | 'muted' | 'bad_headline' | 'bad_colour' |
-- 'bad_effect' | 'bad_emote' | 'bad_dialogue'.
CREATE OR REPLACE FUNCTION accounts.adventure_persona_save_words(p_username text, p_headline text, p_colour int,
                                                                 p_effect int, p_emote text, p_dialogue jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_muted boolean;
    v_old record;
    v_headline text := accounts.adventure_text(p_headline, 80, true);
    v_dialogue jsonb := accounts.adventure_dialogue(p_dialogue);
BEGIN
    -- Not "speaking": a mute is checked below, against the words only.
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF v_headline IS NULL OR position(E'\n' IN v_headline) > 0 THEN RETURN 'bad_headline'; END IF;
    IF p_colour IS NULL OR p_colour NOT BETWEEN 0 AND 11 THEN RETURN 'bad_colour'; END IF;
    IF p_effect IS NULL OR p_effect NOT BETWEEN 0 AND 2 THEN RETURN 'bad_effect'; END IF;
    IF p_emote IS NOT NULL AND NOT (p_emote = ANY (accounts.adventure_emotes())) THEN RETURN 'bad_emote'; END IF;
    IF v_dialogue IS NULL THEN RETURN 'bad_dialogue'; END IF;

    -- A staff "hide" on the log blanks these words under the same lock, so
    -- the words read below cannot be written back over a hide.
    PERFORM pg_advisory_xact_lock(hashtext('adventure_persona:' || v_author.account_id));
    SELECT a.muted_until IS NOT NULL AND a.muted_until > now() INTO v_muted
      FROM public.account a WHERE a.id = v_author.account_id;
    IF v_muted THEN
        SELECT coalesce(pr.headline, '') AS headline, coalesce(pe.dialogue, '[]')::jsonb AS dialogue
          INTO v_old
          FROM (SELECT 1) one
          LEFT JOIN public.adventure_log_profile pr ON pr.account_id = v_author.account_id
          LEFT JOIN public.adventure_persona pe ON pe.account_id = v_author.account_id;
        IF v_old.headline IS DISTINCT FROM v_headline
           OR accounts.adventure_dialogue_lines(v_old.dialogue) IS DISTINCT FROM accounts.adventure_dialogue_lines(v_dialogue) THEN
            RETURN 'muted';
        END IF;
    END IF;

    INSERT INTO public.adventure_log_profile (account_id, headline, updated_at)
    VALUES (v_author.account_id, v_headline, now())
    ON CONFLICT (account_id) DO UPDATE SET headline = excluded.headline, updated_at = excluded.updated_at;

    INSERT INTO public.adventure_persona (account_id, headline_colour, headline_effect, signature_emote, dialogue, updated_at)
    VALUES (v_author.account_id, p_colour, p_effect, p_emote, v_dialogue::text, now())
    ON CONFLICT (account_id) DO UPDATE SET
        headline_colour = excluded.headline_colour, headline_effect = excluded.headline_effect,
        signature_emote = excluded.signature_emote, dialogue = excluded.dialogue,
        updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- Character > Sheet: title, examine, hangout, goals, god and home town.
-- 'ok' | 'not_found' | 'banned' | 'muted' | 'bad_title' | 'bad_examine' |
-- 'bad_hangout' | 'bad_goals' | 'bad_god' | 'bad_key'.
CREATE OR REPLACE FUNCTION accounts.adventure_persona_save_sheet(p_username text, p_title text, p_examine text,
                                                                 p_hangout text, p_goals jsonb, p_god text, p_home text)
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

    -- A staff "hide" on the log blanks these words under the same lock, so
    -- the words read below cannot be written back over a hide.
    PERFORM pg_advisory_xact_lock(hashtext('adventure_persona:' || v_author.account_id));
    SELECT a.muted_until IS NOT NULL AND a.muted_until > now() INTO v_muted
      FROM public.account a WHERE a.id = v_author.account_id;
    IF v_muted THEN
        SELECT coalesce(pe.title, '') AS title, coalesce(pe.examine, '') AS examine,
               coalesce(pe.hangout, '') AS hangout, coalesce(pe.goals, '[]')::jsonb AS goals
          INTO v_old
          FROM (SELECT 1) one
          LEFT JOIN public.adventure_persona pe ON pe.account_id = v_author.account_id;
        IF (v_old.title, v_old.examine, v_old.hangout, v_old.goals)
           IS DISTINCT FROM (v_title, v_examine, v_hangout, v_goals) THEN
            RETURN 'muted';
        END IF;
    END IF;

    INSERT INTO public.adventure_persona (account_id, title, examine, hangout, goals, god, home_town, updated_at)
    VALUES (v_author.account_id, v_title, v_examine, v_hangout, v_goals::text, p_god, p_home, now())
    ON CONFLICT (account_id) DO UPDATE SET
        title = excluded.title, examine = excluded.examine, hangout = excluded.hangout,
        goals = excluded.goals, god = excluded.god, home_town = excluded.home_town,
        updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- Character > Look: the scene to stand in and the way the figure faces.
-- Picks only, so a mute does not matter.
-- 'ok' | 'not_found' | 'banned' | 'bad_key' | 'bad_facing'.
CREATE OR REPLACE FUNCTION accounts.adventure_persona_save_stage(p_username text, p_scene text, p_facing int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF p_scene IS NOT NULL AND p_scene !~ '^[a-z_]{1,24}$' THEN RETURN 'bad_key'; END IF;
    IF p_facing IS NULL OR p_facing NOT BETWEEN 0 AND 15 THEN RETURN 'bad_facing'; END IF;

    INSERT INTO public.adventure_persona (account_id, scene, facing, updated_at)
    VALUES (v_author.account_id, p_scene, p_facing, now())
    ON CONFLICT (account_id) DO UPDATE SET
        scene = excluded.scene, facing = excluded.facing, updated_at = excluded.updated_at;
    RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- clans: the public reads
-- ---------------------------------------------------------------------------

-- A clan's page, for anyone: zero rows for a slug no clan has. `members`
-- counts the members who are not banned; `leader` is NULL while the Leader
-- is banned.
CREATE OR REPLACE FUNCTION accounts.clan_page(p_slug text)
RETURNS TABLE (id int, name text, slug text, motto text, crest int, world int, about text,
               created_at timestamptz, members int, leader text,
               perm_invite int, perm_remove int, perm_ranks int, perm_page int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.id, c.name, c.slug, c.motto, c.crest, c.world::int, c.about, c.created_at,
           (SELECT count(*)::int
              FROM public.adventure_clan_member m
              JOIN public.account a ON a.id = m.account_id
             WHERE m.clan_id = c.id
               AND (a.banned_until IS NULL OR a.banned_until <= now())),
           (SELECT a.username
              FROM public.adventure_clan_member m
              JOIN public.account a ON a.id = m.account_id
             WHERE m.clan_id = c.id AND m.rank = 'leader'
               AND (a.banned_until IS NULL OR a.banned_until <= now())),
           c.perm_invite::int, c.perm_remove::int, c.perm_ranks::int, c.perm_page::int
      FROM public.adventure_clan c
     WHERE c.slug = p_slug;
$$;

-- A clan's members who are not banned, by rank and then by who joined first.
CREATE OR REPLACE FUNCTION accounts.clan_members(p_clan_id int)
RETURNS TABLE (username text, rank text, joined_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.username, m.rank, m.joined_at
      FROM public.adventure_clan_member m
      JOIN public.account a ON a.id = m.account_id
     WHERE m.clan_id = p_clan_id
       AND (a.banned_until IS NULL OR a.banned_until <= now())
     ORDER BY accounts.clan_rank_level(m.rank), m.joined_at, a.username;
$$;

-- A clan's notices, newest first, at most 20; deleted ones are not shown.
-- `author_rank` is NULL once the author has left the clan; a banned author's
-- notices are not shown.
CREATE OR REPLACE FUNCTION accounts.clan_notices(p_clan_id int)
RETURNS TABLE (id int, title text, body text, author text, author_rank text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT n.id, n.title, n.body, a.username, m.rank, n.created_at
      FROM public.adventure_clan_notice n
      JOIN public.account a ON a.id = n.author_account_id
      LEFT JOIN public.adventure_clan_member m ON m.account_id = n.author_account_id AND m.clan_id = n.clan_id
     WHERE n.clan_id = p_clan_id
       AND n.deleted_at IS NULL
       AND (a.banned_until IS NULL OR a.banned_until <= now())
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT 20;
$$;

-- Every clan with at least one member who is not banned, the largest first
-- and then by name, at most 200.
CREATE OR REPLACE FUNCTION accounts.clan_directory()
RETURNS TABLE (name text, slug text, motto text, crest int, members int, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.name, c.slug, c.motto, c.crest, v.members, c.created_at
      FROM public.adventure_clan c
      JOIN LATERAL (
        SELECT count(*)::int AS members
          FROM public.adventure_clan_member m
          JOIN public.account a ON a.id = m.account_id
         WHERE m.clan_id = c.id
           AND (a.banned_until IS NULL OR a.banned_until <= now())
      ) v ON true
     WHERE v.members > 0
     ORDER BY v.members DESC, c.name, c.id
     LIMIT 200;
$$;

-- The clan behind a name, for the card's Clan row: zero rows for an unknown
-- or banned account, or one in no clan.
CREATE OR REPLACE FUNCTION accounts.clan_of(p_name text)
RETURNS TABLE (clan_id int, name text, slug text, rank text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.id, c.name, c.slug, m.rank
      FROM public.account a
      JOIN public.adventure_clan_member m ON m.account_id = a.id
      JOIN public.adventure_clan c ON c.id = m.clan_id
     WHERE a.username = p_name
       AND (a.banned_until IS NULL OR a.banned_until <= now());
$$;

-- The invites waiting for p_username, newest first. An invite stands if its
-- sender later leaves (`invited_by_rank` is then NULL). Nothing for a banned
-- account.
CREATE OR REPLACE FUNCTION accounts.clan_invites_for(p_username text)
RETURNS TABLE (clan_id int, name text, slug text, motto text, crest int, members int,
               invited_by text, invited_by_rank text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.id, c.name, c.slug, c.motto, c.crest,
           (SELECT count(*)::int
              FROM public.adventure_clan_member m
              JOIN public.account ma ON ma.id = m.account_id
             WHERE m.clan_id = c.id
               AND (ma.banned_until IS NULL OR ma.banned_until <= now())),
           ib.username, ibm.rank, i.created_at
      FROM public.account a
      JOIN public.adventure_clan_invite i ON i.account_id = a.id
      JOIN public.adventure_clan c ON c.id = i.clan_id
      JOIN public.account ib ON ib.id = i.invited_by_account_id
      LEFT JOIN public.adventure_clan_member ibm ON ibm.account_id = ib.id AND ibm.clan_id = i.clan_id
     WHERE a.username = p_username
       AND (a.banned_until IS NULL OR a.banned_until <= now())
     ORDER BY i.created_at DESC, c.id;
$$;

-- The invites p_username's clan has sent and nobody has answered, newest
-- first; every member sees them. Nothing for someone in no clan, or banned.
CREATE OR REPLACE FUNCTION accounts.clan_invites_sent(p_username text)
RETURNS TABLE (username text, invited_by text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.username, ib.username, i.created_at
      FROM public.account me
      JOIN public.adventure_clan_member mm ON mm.account_id = me.id
      JOIN public.adventure_clan_invite i ON i.clan_id = mm.clan_id
      JOIN public.account t ON t.id = i.account_id
      JOIN public.account ib ON ib.id = i.invited_by_account_id
     WHERE me.username = p_username
       AND (me.banned_until IS NULL OR me.banned_until <= now())
     ORDER BY i.created_at DESC, t.username;
$$;

-- ---------------------------------------------------------------------------
-- clans: the writes
-- ---------------------------------------------------------------------------

-- Start a clan; the caller becomes its Leader. The name is words, so a mute
-- stops it.
-- 'ok' | 'not_found' | 'banned' | 'muted' | 'bad_name' | 'bad_motto' |
-- 'bad_crest' | 'bad_world' | 'in_clan' | 'taken'.
CREATE OR REPLACE FUNCTION accounts.clan_create(p_username text, p_name text, p_motto text, p_crest int, p_world int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_motto text := accounts.adventure_text(p_motto, 80, true);
    v_id int;
BEGIN
    v_author := accounts.adventure_author(p_username, true);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF NOT accounts.clan_name_ok(p_name) THEN RETURN 'bad_name'; END IF;
    IF v_motto IS NULL OR position(E'\n' IN v_motto) > 0 THEN RETURN 'bad_motto'; END IF;
    IF p_crest IS NULL OR p_crest NOT BETWEEN 0 AND 65535 THEN RETURN 'bad_crest'; END IF;
    IF p_world IS NOT NULL AND p_world NOT BETWEEN 1 AND 255 THEN RETURN 'bad_world'; END IF;

    PERFORM pg_advisory_xact_lock(hashtext('clan-account:' || v_author.account_id));
    IF EXISTS (SELECT 1 FROM public.adventure_clan_member m WHERE m.account_id = v_author.account_id) THEN
        RETURN 'in_clan';
    END IF;
    IF EXISTS (SELECT 1 FROM public.adventure_clan c WHERE c.slug = accounts.clan_slug(p_name)) THEN
        RETURN 'taken';
    END IF;

    BEGIN
        INSERT INTO public.adventure_clan (name, slug, motto, crest, world)
        VALUES (p_name, accounts.clan_slug(p_name), v_motto, p_crest, p_world)
        RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        -- another clan took the slug since the check above
        RETURN 'taken';
    END;
    INSERT INTO public.adventure_clan_member (account_id, clan_id, rank)
    VALUES (v_author.account_id, v_id, 'leader');
    RETURN 'ok';
END;
$$;

-- The clan page: name, motto, crest, world and About, for members the "page"
-- threshold allows. A clan keeps a name it already has, even a staff
-- 'Clan <id>'. A mute refuses the save only when the name, motto or About
-- would change.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden' | 'bad_name' |
-- 'bad_motto' | 'bad_crest' | 'bad_world' | 'bad_about' | 'muted' | 'taken'.
CREATE OR REPLACE FUNCTION accounts.clan_save_page(p_username text, p_name text, p_motto text, p_crest int,
                                                   p_world int, p_about text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
    v_clan record;
    v_muted boolean;
    v_motto text := accounts.adventure_text(p_motto, 80, true);
    v_about text := accounts.adventure_text(p_about, 600, true);
BEGIN
    -- Not "speaking": a mute is checked below, against the words only.
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    SELECT * INTO v_clan FROM public.adventure_clan c WHERE c.id = v_me.clan_id;
    IF v_me.rank_level > v_clan.perm_page THEN RETURN 'forbidden'; END IF;

    IF p_name IS DISTINCT FROM v_clan.name AND NOT accounts.clan_name_ok(p_name) THEN RETURN 'bad_name'; END IF;
    IF v_motto IS NULL OR position(E'\n' IN v_motto) > 0 THEN RETURN 'bad_motto'; END IF;
    IF p_crest IS NULL OR p_crest NOT BETWEEN 0 AND 65535 THEN RETURN 'bad_crest'; END IF;
    IF p_world IS NOT NULL AND p_world NOT BETWEEN 1 AND 255 THEN RETURN 'bad_world'; END IF;
    IF v_about IS NULL THEN RETURN 'bad_about'; END IF;

    SELECT a.muted_until IS NOT NULL AND a.muted_until > now() INTO v_muted
      FROM public.account a WHERE a.id = v_author.account_id;
    IF v_muted AND (v_clan.name, v_clan.motto, v_clan.about) IS DISTINCT FROM (p_name, v_motto, v_about) THEN
        RETURN 'muted';
    END IF;

    IF EXISTS (SELECT 1 FROM public.adventure_clan c
                WHERE c.slug = accounts.clan_slug(p_name) AND c.id <> v_clan.id) THEN
        RETURN 'taken';
    END IF;

    BEGIN
        UPDATE public.adventure_clan c
           SET name = p_name, slug = accounts.clan_slug(p_name), motto = v_motto, crest = p_crest,
               world = p_world, about = v_about, updated_at = now()
         WHERE c.id = v_clan.id;
    EXCEPTION WHEN unique_violation THEN
        RETURN 'taken';
    END;
    RETURN 'ok';
END;
$$;

-- The Leader's "who can..." thresholds, each 0 (the Leader only) .. 6 (every
-- member). Picks, so a mute does not matter.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden' | 'bad_perm'.
CREATE OR REPLACE FUNCTION accounts.clan_set_perms(p_username text, p_invite int, p_remove int, p_ranks int, p_page int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    IF v_me.rank <> 'leader' THEN RETURN 'forbidden'; END IF;

    IF p_invite IS NULL OR p_invite NOT BETWEEN 0 AND 6
       OR p_remove IS NULL OR p_remove NOT BETWEEN 0 AND 6
       OR p_ranks IS NULL OR p_ranks NOT BETWEEN 0 AND 6
       OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 6 THEN RETURN 'bad_perm'; END IF;

    UPDATE public.adventure_clan c
       SET perm_invite = p_invite, perm_remove = p_remove, perm_ranks = p_ranks, perm_page = p_page,
           updated_at = now()
     WHERE c.id = v_me.clan_id;
    RETURN 'ok';
END;
$$;

-- Invite a player into the caller's clan. A pick, so a muted member may.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden' |
-- 'no_such_player' (unknown or banned) | 'self' | 'in_clan' | 'already' |
-- 'full' (50 members) | 'too_many' (20 pending).
CREATE OR REPLACE FUNCTION accounts.clan_invite(p_username text, p_target text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
    v_target_id int;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    IF v_me.rank_level > (SELECT c.perm_invite FROM public.adventure_clan c WHERE c.id = v_me.clan_id) THEN
        RETURN 'forbidden';
    END IF;

    SELECT a.id INTO v_target_id FROM public.account a
     WHERE a.username = p_target AND (a.banned_until IS NULL OR a.banned_until <= now());
    IF v_target_id IS NULL THEN RETURN 'no_such_player'; END IF;
    IF v_target_id = v_author.account_id THEN RETURN 'self'; END IF;
    IF EXISTS (SELECT 1 FROM public.adventure_clan_member m WHERE m.account_id = v_target_id) THEN RETURN 'in_clan'; END IF;
    IF EXISTS (SELECT 1 FROM public.adventure_clan_invite i
                WHERE i.clan_id = v_me.clan_id AND i.account_id = v_target_id) THEN RETURN 'already'; END IF;
    IF (SELECT count(*) FROM public.adventure_clan_member m WHERE m.clan_id = v_me.clan_id) >= 50 THEN RETURN 'full'; END IF;
    IF (SELECT count(*) FROM public.adventure_clan_invite i WHERE i.clan_id = v_me.clan_id) >= 20 THEN RETURN 'too_many'; END IF;

    INSERT INTO public.adventure_clan_invite (clan_id, account_id, invited_by_account_id)
    VALUES (v_me.clan_id, v_target_id, v_author.account_id);
    RETURN 'ok';
END;
$$;

-- Take back an invite the caller's clan sent.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden' | 'no_invite'.
CREATE OR REPLACE FUNCTION accounts.clan_invite_cancel(p_username text, p_target text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    IF v_me.rank_level > (SELECT c.perm_invite FROM public.adventure_clan c WHERE c.id = v_me.clan_id) THEN
        RETURN 'forbidden';
    END IF;

    DELETE FROM public.adventure_clan_invite i
     USING public.account a
     WHERE a.username = p_target AND i.account_id = a.id AND i.clan_id = v_me.clan_id;
    IF NOT FOUND THEN RETURN 'no_invite'; END IF;
    RETURN 'ok';
END;
$$;

-- Answer an invite: accepting joins as a Recruit and deletes that invite
-- only; declining (or a NULL answer) deletes it. A pick, so a muted player
-- may answer.
-- 'ok' | 'not_found' | 'banned' | 'no_invite' | 'in_clan' | 'full'.
CREATE OR REPLACE FUNCTION accounts.clan_invite_answer(p_username text, p_clan_id int, p_accept boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;

    IF NOT coalesce(p_accept, false) THEN
        DELETE FROM public.adventure_clan_invite i
         WHERE i.clan_id = p_clan_id AND i.account_id = v_author.account_id;
        IF NOT FOUND THEN RETURN 'no_invite'; END IF;
        RETURN 'ok';
    END IF;

    -- the clan, then the account: the one order anything takes both in
    PERFORM pg_advisory_xact_lock(hashtext('clan:' || p_clan_id));
    PERFORM pg_advisory_xact_lock(hashtext('clan-account:' || v_author.account_id));
    IF NOT EXISTS (SELECT 1 FROM public.adventure_clan_invite i
                    WHERE i.clan_id = p_clan_id AND i.account_id = v_author.account_id) THEN
        RETURN 'no_invite';
    END IF;
    IF EXISTS (SELECT 1 FROM public.adventure_clan_member m WHERE m.account_id = v_author.account_id) THEN
        RETURN 'in_clan';
    END IF;
    IF (SELECT count(*) FROM public.adventure_clan_member m WHERE m.clan_id = p_clan_id) >= 50 THEN
        RETURN 'full';
    END IF;

    INSERT INTO public.adventure_clan_member (account_id, clan_id, rank)
    VALUES (v_author.account_id, p_clan_id, 'recruit');
    DELETE FROM public.adventure_clan_invite i
     WHERE i.clan_id = p_clan_id AND i.account_id = v_author.account_id;
    RETURN 'ok';
END;
$$;

-- Give a member a rank: only a member the caller outranks, only a rank below
-- the caller's own. 'leader' is not a rank to give: the key moves by
-- hand-over.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden' |
-- 'no_such_member' | 'bad_rank'.
CREATE OR REPLACE FUNCTION accounts.clan_set_rank(p_username text, p_target text, p_rank text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
    v_target record;
    v_level int := accounts.clan_rank_level(p_rank);
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    IF v_me.rank_level > (SELECT c.perm_ranks FROM public.adventure_clan c WHERE c.id = v_me.clan_id) THEN
        RETURN 'forbidden';
    END IF;

    SELECT m.account_id, accounts.clan_rank_level(m.rank) AS rank_level INTO v_target
      FROM public.account a
      JOIN public.adventure_clan_member m ON m.account_id = a.id AND m.clan_id = v_me.clan_id
     WHERE a.username = p_target;
    IF v_target.account_id IS NULL THEN RETURN 'no_such_member'; END IF;
    IF v_level IS NULL OR v_level = 0 THEN RETURN 'bad_rank'; END IF;
    IF v_target.rank_level <= v_me.rank_level OR v_level <= v_me.rank_level THEN RETURN 'forbidden'; END IF;

    UPDATE public.adventure_clan_member m SET rank = p_rank WHERE m.account_id = v_target.account_id;
    RETURN 'ok';
END;
$$;

-- Remove a member the caller outranks. Leaving is clan_leave.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden' |
-- 'no_such_member' | 'self'.
CREATE OR REPLACE FUNCTION accounts.clan_remove(p_username text, p_target text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
    v_target record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    IF v_me.rank_level > (SELECT c.perm_remove FROM public.adventure_clan c WHERE c.id = v_me.clan_id) THEN
        RETURN 'forbidden';
    END IF;

    SELECT m.account_id, accounts.clan_rank_level(m.rank) AS rank_level INTO v_target
      FROM public.account a
      JOIN public.adventure_clan_member m ON m.account_id = a.id AND m.clan_id = v_me.clan_id
     WHERE a.username = p_target;
    IF v_target.account_id IS NULL THEN RETURN 'no_such_member'; END IF;
    IF v_target.account_id = v_author.account_id THEN RETURN 'self'; END IF;
    IF v_target.rank_level <= v_me.rank_level THEN RETURN 'forbidden'; END IF;

    DELETE FROM public.adventure_clan_member m WHERE m.account_id = v_target.account_id;
    RETURN 'ok';
END;
$$;

-- Leave the clan. The Leader cannot while anyone else is in it ('leader');
-- a Leader who is the last member disbands it by leaving. A pick, so a
-- muted member may leave.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'leader'.
CREATE OR REPLACE FUNCTION accounts.clan_leave(p_username text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;

    IF v_me.rank = 'leader' THEN
        IF EXISTS (SELECT 1 FROM public.adventure_clan_member m
                    WHERE m.clan_id = v_me.clan_id AND m.account_id <> v_author.account_id) THEN
            RETURN 'leader';
        END IF;
        -- The last member: leaving disbands the clan. clan_disband takes the
        -- clan's lock again, which this transaction already holds.
        RETURN accounts.clan_disband(p_username);
    END IF;

    DELETE FROM public.adventure_clan_member m WHERE m.account_id = v_author.account_id;
    RETURN 'ok';
END;
$$;

-- Hand the key to another member who is not banned: they become the Leader
-- and the caller a General.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden' |
-- 'no_such_member' | 'self'.
CREATE OR REPLACE FUNCTION accounts.clan_hand_over(p_username text, p_target text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
    v_target_id int;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    IF v_me.rank <> 'leader' THEN RETURN 'forbidden'; END IF;

    SELECT m.account_id INTO v_target_id
      FROM public.account a
      JOIN public.adventure_clan_member m ON m.account_id = a.id AND m.clan_id = v_me.clan_id
     WHERE a.username = p_target AND (a.banned_until IS NULL OR a.banned_until <= now());
    IF v_target_id IS NULL THEN RETURN 'no_such_member'; END IF;
    IF v_target_id = v_author.account_id THEN RETURN 'self'; END IF;

    -- the old key first: one Leader per clan is a unique index
    UPDATE public.adventure_clan_member m SET rank = 'general' WHERE m.account_id = v_author.account_id;
    UPDATE public.adventure_clan_member m SET rank = 'leader' WHERE m.account_id = v_target_id;
    RETURN 'ok';
END;
$$;

-- Disband the clan: the Leader only. Deletes the clan, its members, its
-- invites and its notices. clan_leave disbands through it too.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden'.
CREATE OR REPLACE FUNCTION accounts.clan_disband(p_username text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;
    IF v_me.rank <> 'leader' THEN RETURN 'forbidden'; END IF;

    DELETE FROM public.adventure_clan_notice n WHERE n.clan_id = v_me.clan_id;
    DELETE FROM public.adventure_clan_invite i WHERE i.clan_id = v_me.clan_id;
    DELETE FROM public.adventure_clan_member m WHERE m.clan_id = v_me.clan_id;
    DELETE FROM public.adventure_clan c WHERE c.id = v_me.clan_id;
    RETURN 'ok';
END;
$$;

-- Post a notice. Words, so a mute stops it. Ten per clan a day, counting the
-- deleted ones, so deleting does not free a place. The newest twenty live
-- notices are kept and older ones deleted here, and so are deleted ones once
-- their day is over.
-- 'ok' | 'not_found' | 'banned' | 'muted' | 'not_member' | 'forbidden' |
-- 'bad_title' | 'bad_body' | 'rate_limited'.
CREATE OR REPLACE FUNCTION accounts.clan_notice_post(p_username text, p_title text, p_body text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
    v_title text := accounts.adventure_text(p_title, 40, false);
    v_body text := accounts.adventure_text(p_body, 280, false);
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

-- Delete a notice: its author, or anyone the "page" threshold allows. It is
-- marked, not removed, so it still counts towards the clan's ten a day; a
-- notice already deleted is 'no_notice'.
-- 'ok' | 'not_found' | 'banned' | 'not_member' | 'forbidden' | 'no_notice'.
CREATE OR REPLACE FUNCTION accounts.clan_notice_delete(p_username text, p_id int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_author record;
    v_me record;
    v_notice_author int;
BEGIN
    v_author := accounts.adventure_author(p_username, false);
    IF v_author.result <> 'ok' THEN RETURN v_author.result; END IF;
    v_me := accounts.clan_membership(v_author.account_id);
    IF v_me.clan_id IS NULL THEN RETURN 'not_member'; END IF;

    SELECT n.author_account_id INTO v_notice_author
      FROM public.adventure_clan_notice n
     WHERE n.id = p_id AND n.clan_id = v_me.clan_id AND n.deleted_at IS NULL;
    IF v_notice_author IS NULL THEN RETURN 'no_notice'; END IF;
    IF v_notice_author <> v_author.account_id
       AND v_me.rank_level > (SELECT c.perm_page FROM public.adventure_clan c WHERE c.id = v_me.clan_id) THEN
        RETURN 'forbidden';
    END IF;

    UPDATE public.adventure_clan_notice n SET deleted_at = now() WHERE n.id = p_id;
    RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- adventure_report, staff_adventure_reports and staff_adventure_resolve,
-- replaced in place (017)
-- ---------------------------------------------------------------------------

-- 'ok' | 'not_found' (reporter, or target) | 'banned' | 'bad_kind' |
-- 'bad_reason' | 'self' | 'already' | 'rate_limited'.
--
-- p_kind 'update' or 'reply' takes p_target_id; 'log' takes p_log_name and
-- reports that log's own text (headline, about, CSS); 'clan' (017) takes the
-- clan's id in p_target_id and reports its words (name, motto, About). A
-- member reporting their own clan is 'self'.
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
    ELSIF p_kind = 'clan' THEN
        -- A clan's "owner", for the self check, is the reporter when they
        -- are one of its members.
        SELECT c.id, m.account_id INTO v_target, v_target_owner
          FROM public.adventure_clan c
          LEFT JOIN public.adventure_clan_member m ON m.clan_id = c.id AND m.account_id = v_author.account_id
         WHERE c.id = p_target_id;
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
-- is what was reported as it stands: the update or reply, for a log its
-- headline and about (its CSS is `css`), and for a clan its motto and About
-- (017), with `log_owner` the clan's name and `author` its Leader.
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
                    CASE WHEN lo.id IS NOT NULL THEN coalesce(lp.headline, '') || E'\n\n' || coalesce(lp.about, '') END,
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
-- p_action is 'hide' (the update or reply; for a log, its headline, about
-- and persona words are cleared; for a clan (017), its motto and About are
-- cleared, its notices deleted (marked) and it is renamed 'Clan <id>'),
-- 'disable_css' (a log only) or 'dismiss'. The typed password is checked the
-- way staff_report_resolve checks it, in the same limiter.
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
            UPDATE public.adventure_log_profile SET headline = '', about = '', updated_at = now() WHERE account_id = v_report.target_id;
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
-- Twenty-four grants: adventure_persona again (dropped and made anew above),
-- the three persona writers, seven clan reads and thirteen clan writes. With
-- adventure_persona_save gone that takes the `website` role from eighty-six
-- to one hundred and eight. The five helpers are granted to nobody;
-- adventure_report, staff_adventure_reports and staff_adventure_resolve keep
-- their grants from 013. Still no privilege of any kind on schema public.

REVOKE ALL ON FUNCTION accounts.clan_rank_level(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_name_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_membership(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_dialogue_lines(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona_save_words(text, text, int, int, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona_save_sheet(text, text, text, text, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.adventure_persona_save_stage(text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_page(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_members(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_notices(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_of(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_invites_for(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_invites_sent(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_create(text, text, text, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_save_page(text, text, text, int, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_set_perms(text, int, int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_invite(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_invite_cancel(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_invite_answer(text, int, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_set_rank(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_remove(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_leave(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_hand_over(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_disband(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_notice_post(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.clan_notice_delete(text, int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.adventure_persona(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_persona_save_words(text, text, int, int, text, jsonb) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_persona_save_sheet(text, text, text, text, jsonb, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.adventure_persona_save_stage(text, text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_page(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_members(int) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_notices(int) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_directory() TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_of(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_invites_for(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_invites_sent(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_create(text, text, text, int, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_save_page(text, text, text, int, int, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_set_perms(text, int, int, int, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_invite(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_invite_cancel(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_invite_answer(text, int, boolean) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_set_rank(text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_remove(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_leave(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_hand_over(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_disband(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_notice_post(text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.clan_notice_delete(text, int) TO website;

-- rollback:
--
-- Drops every clan, notice (deleted ones too: deleted_at is made with its
-- table, so the table's drop takes it), invite and clan report, and every
-- facing; the persona's clan and playstyle come back empty. Then re-run, from
-- 016_adventure_persona, the CREATE OR REPLACE blocks of
-- adventure_persona_words, adventure_persona, adventure_persona_save and
-- staff_adventure_resolve, with their REVOKE and GRANT lines; and from
-- 013_adventurer_log, the blocks of adventure_report and
-- staff_adventure_reports. Take a dump first.
--
-- Roll the Website back to its state before W4 (Website PR #53) BEFORE
-- running this rollback: W4 and every later Website PR read 017's shapes
-- (the persona's facing, the three persona writers and the clan functions),
-- so while W4 is live, 017 only goes forward.
--
-- DELETE FROM "adventure_report" WHERE "target_kind" = 'clan';
-- ALTER TABLE "adventure_report" DROP CONSTRAINT IF EXISTS "adventure_report_kind";
-- ALTER TABLE "adventure_report" ADD CONSTRAINT "adventure_report_kind" CHECK ("target_kind" IN ('update', 'reply', 'log'));
-- DROP FUNCTION IF EXISTS accounts.clan_notice_delete(text, int);
-- DROP FUNCTION IF EXISTS accounts.clan_notice_post(text, text, text);
-- DROP FUNCTION IF EXISTS accounts.clan_disband(text);
-- DROP FUNCTION IF EXISTS accounts.clan_hand_over(text, text);
-- DROP FUNCTION IF EXISTS accounts.clan_leave(text);
-- DROP FUNCTION IF EXISTS accounts.clan_remove(text, text);
-- DROP FUNCTION IF EXISTS accounts.clan_set_rank(text, text, text);
-- DROP FUNCTION IF EXISTS accounts.clan_invite_answer(text, int, boolean);
-- DROP FUNCTION IF EXISTS accounts.clan_invite_cancel(text, text);
-- DROP FUNCTION IF EXISTS accounts.clan_invite(text, text);
-- DROP FUNCTION IF EXISTS accounts.clan_set_perms(text, int, int, int, int);
-- DROP FUNCTION IF EXISTS accounts.clan_save_page(text, text, text, int, int, text);
-- DROP FUNCTION IF EXISTS accounts.clan_create(text, text, text, int, int);
-- DROP FUNCTION IF EXISTS accounts.clan_invites_sent(text);
-- DROP FUNCTION IF EXISTS accounts.clan_invites_for(text);
-- DROP FUNCTION IF EXISTS accounts.clan_of(text);
-- DROP FUNCTION IF EXISTS accounts.clan_directory();
-- DROP FUNCTION IF EXISTS accounts.clan_notices(int);
-- DROP FUNCTION IF EXISTS accounts.clan_members(int);
-- DROP FUNCTION IF EXISTS accounts.clan_page(text);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona_save_stage(text, text, int);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona_save_sheet(text, text, text, text, jsonb, text, text);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona_save_words(text, text, int, int, text, jsonb);
-- DROP FUNCTION IF EXISTS accounts.adventure_persona(text);
-- DROP FUNCTION IF EXISTS accounts.adventure_dialogue_lines(jsonb);
-- DROP FUNCTION IF EXISTS accounts.clan_membership(int);
-- DROP FUNCTION IF EXISTS accounts.clan_name_ok(text);
-- DROP FUNCTION IF EXISTS accounts.clan_slug(text);
-- DROP FUNCTION IF EXISTS accounts.clan_rank_level(text);
-- DROP TABLE IF EXISTS "adventure_clan_notice";
-- DROP TABLE IF EXISTS "adventure_clan_invite";
-- DROP TABLE IF EXISTS "adventure_clan_member";
-- DROP TABLE IF EXISTS "adventure_clan";
-- ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_facing";
-- ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "facing";
-- ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "clan" TEXT NOT NULL DEFAULT '';
-- ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "playstyle" TEXT;
-- ALTER TABLE "adventure_persona" ADD CONSTRAINT "adventure_persona_clan" CHECK (length("clan") <= 24);
-- ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_keys";
-- ALTER TABLE "adventure_persona" ADD CONSTRAINT "adventure_persona_keys" CHECK (("home_town" IS NULL OR "home_town" ~ '^[a-z_]{1,24}$') AND ("playstyle" IS NULL OR "playstyle" ~ '^[a-z_]{1,24}$') AND ("scene" IS NULL OR "scene" ~ '^[a-z_]{1,24}$'));
