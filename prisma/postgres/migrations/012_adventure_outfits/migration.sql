-- 012_adventure_outfits: fashionscape, the Adventurer Log's outfits.
--
-- A player keeps up to ten outfits on the website. Each is a look - gender,
-- the seven identity kits, the five colours and an object in each of the
-- fourteen worn slots - and a name. One of them is the default, and its
-- chathead is the player's picture on their log and beside what they post.
--
-- Anyone may wear anything: an outfit is not a claim to own what is in it.
-- What the database checks is the shape and the ranges; whether a kit is one
-- the design screen offers, or an object goes in the slot it is put in, is the
-- website's (`lib/chathead/validate.ts`, from the same cache the game packs),
-- because that knowledge is not in this database.
--
-- ## The rules, in one place
--
-- - Slots are 0..9. Saving into a slot replaces what was there.
-- - The first outfit a player saves becomes the default. Deleting the default
--   leaves none; the player picks another. At most one default per account,
--   which a partial unique index enforces.
-- - Names are 1..32 characters after trimming, with no control characters.
-- - Banned accounts cannot save, delete or change their default; they keep
--   what they had.
-- - "Import from game" reads `account_look` (migration 11), the look of the
--   player's last save, and writes nothing: the editor puts it in a slot and
--   the player saves it.
-- - `outfit_default_looks` is the only read of anyone else's outfit: the
--   default look behind each name, which is what a public page draws a
--   chathead from. Names, the other nine and whether an outfit exists at all
--   beyond the default are the owner's.
--
-- JSON arrays in text columns, like account_look, because every backend
-- carries the table. No foreign keys, like every other table.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "adventure_outfit" (
    "account_id" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "gender" INTEGER NOT NULL,
    "kits" TEXT NOT NULL,
    "colours" TEXT NOT NULL,
    "worn" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_outfit_pkey" PRIMARY KEY ("account_id", "slot"),
    CONSTRAINT "adventure_outfit_slot" CHECK ("slot" BETWEEN 0 AND 9),
    CONSTRAINT "adventure_outfit_name" CHECK (length("name") BETWEEN 1 AND 32),
    CONSTRAINT "adventure_outfit_gender" CHECK ("gender" IN (0, 1))
);

-- The database's own guarantee of one default per account. Postgres only -
-- Prisma has no way to say "partial", and nothing else runs these functions.
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_outfit_one_default_key" ON "adventure_outfit"("account_id") WHERE "is_default";

ALTER TABLE "adventure_outfit" ENABLE ROW LEVEL SECURITY;

-- === functions ===

-- ---------------------------------------------------------------------------
-- internal helpers: NOT granted to website
-- ---------------------------------------------------------------------------

-- Every entry an integer in [lo, hi], and exactly `n` of them.
CREATE OR REPLACE FUNCTION accounts.outfit_ints_ok(p_values int[], p_n int, p_lo int, p_hi int) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p_values IS NOT NULL
       AND coalesce(array_length(p_values, 1), 0) = p_n
       AND array_ndims(p_values) = 1
       AND NOT EXISTS (SELECT 1 FROM unnest(p_values) v WHERE v IS NULL OR v < p_lo OR v > p_hi);
$$;

-- The shape of a look: two genders, seven kit ids (an idk id is a byte in the
-- save, -1 for none), five colours each inside its design palette (the
-- engine's Player.DESIGN_BODY_COLORS: 12, 16, 16, 6 and 8 long), fourteen
-- worn slots of object ids or -1.
CREATE OR REPLACE FUNCTION accounts.outfit_look_ok(p_gender int, p_kits int[], p_colours int[], p_worn int[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p_gender IN (0, 1)
       AND accounts.outfit_ints_ok(p_kits, 7, -1, 255)
       AND accounts.outfit_ints_ok(p_colours, 5, 0, 15)
       AND p_colours[1] < 12 AND p_colours[4] < 6 AND p_colours[5] < 8
       AND accounts.outfit_ints_ok(p_worn, 14, -1, 65535);
$$;

-- An account that may change its outfits: 'ok' with its id, or why not.
CREATE OR REPLACE FUNCTION accounts.outfit_owner(p_username text, OUT result text, OUT account_id int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_banned_until timestamptz;
BEGIN
    SELECT a.id, a.banned_until INTO account_id, v_banned_until
      FROM public.account a
     WHERE a.username = p_username;

    IF account_id IS NULL THEN
        result := 'not_found';
    ELSIF v_banned_until IS NOT NULL AND v_banned_until > now() THEN
        result := 'banned';
    ELSE
        result := 'ok';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- the owner's reads and writes
-- ---------------------------------------------------------------------------

-- The player's own outfits, by slot. An unknown name has none.
CREATE OR REPLACE FUNCTION accounts.outfits(p_username text)
RETURNS TABLE (slot int, name text, gender int, kits jsonb, colours jsonb, worn jsonb, is_default boolean, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT o.slot, o.name, o.gender, o.kits::jsonb, o.colours::jsonb, o.worn::jsonb, o.is_default, o.updated_at
      FROM public.adventure_outfit o
      JOIN public.account a ON a.id = o.account_id
     WHERE a.username = p_username
     ORDER BY o.slot;
$$;

-- 'ok' | 'not_found' | 'banned' | 'bad_slot' | 'bad_name' | 'bad_look'.
--
-- The name is resolved before anything else, so an unknown one writes
-- nothing: db:check calls this against a name nobody has.
CREATE OR REPLACE FUNCTION accounts.outfit_save(p_username text, p_slot int, p_name text, p_gender int, p_kits int[], p_colours int[], p_worn int[])
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_owner record;
    v_name text := btrim(coalesce(p_name, ''));
BEGIN
    v_owner := accounts.outfit_owner(p_username);
    IF v_owner.result <> 'ok' THEN
        RETURN v_owner.result;
    END IF;

    IF p_slot IS NULL OR p_slot < 0 OR p_slot > 9 THEN
        RETURN 'bad_slot';
    END IF;

    IF length(v_name) < 1 OR length(v_name) > 32 OR v_name ~ '[[:cntrl:]]' THEN
        RETURN 'bad_name';
    END IF;

    IF NOT coalesce(accounts.outfit_look_ok(p_gender, p_kits, p_colours, p_worn), false) THEN
        RETURN 'bad_look';
    END IF;

    -- Two tabs saving at once must not both become the first outfit.
    PERFORM pg_advisory_xact_lock(hashtext('outfit:' || v_owner.account_id));

    INSERT INTO public.adventure_outfit (account_id, slot, name, gender, kits, colours, worn, is_default, updated_at)
    VALUES (
        v_owner.account_id, p_slot, v_name, p_gender,
        to_jsonb(p_kits)::text, to_jsonb(p_colours)::text, to_jsonb(p_worn)::text,
        NOT EXISTS (SELECT 1 FROM public.adventure_outfit o WHERE o.account_id = v_owner.account_id AND o.is_default),
        now()
    )
    ON CONFLICT (account_id, slot) DO UPDATE
       SET name = excluded.name,
           gender = excluded.gender,
           kits = excluded.kits,
           colours = excluded.colours,
           worn = excluded.worn,
           is_default = adventure_outfit.is_default OR NOT EXISTS (
               SELECT 1 FROM public.adventure_outfit o WHERE o.account_id = excluded.account_id AND o.is_default
           ),
           updated_at = excluded.updated_at;

    RETURN 'ok';
END;
$$;

-- 'ok' | 'not_found' | 'banned' | 'bad_slot' | 'empty'.
CREATE OR REPLACE FUNCTION accounts.outfit_delete(p_username text, p_slot int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_owner record;
BEGIN
    v_owner := accounts.outfit_owner(p_username);
    IF v_owner.result <> 'ok' THEN
        RETURN v_owner.result;
    END IF;

    IF p_slot IS NULL OR p_slot < 0 OR p_slot > 9 THEN
        RETURN 'bad_slot';
    END IF;

    DELETE FROM public.adventure_outfit o WHERE o.account_id = v_owner.account_id AND o.slot = p_slot;
    IF NOT FOUND THEN
        RETURN 'empty';
    END IF;

    RETURN 'ok';
END;
$$;

-- 'ok' | 'not_found' | 'banned' | 'bad_slot' | 'empty'.
CREATE OR REPLACE FUNCTION accounts.outfit_set_default(p_username text, p_slot int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_owner record;
BEGIN
    v_owner := accounts.outfit_owner(p_username);
    IF v_owner.result <> 'ok' THEN
        RETURN v_owner.result;
    END IF;

    IF p_slot IS NULL OR p_slot < 0 OR p_slot > 9 THEN
        RETURN 'bad_slot';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('outfit:' || v_owner.account_id));

    IF NOT EXISTS (SELECT 1 FROM public.adventure_outfit o WHERE o.account_id = v_owner.account_id AND o.slot = p_slot) THEN
        RETURN 'empty';
    END IF;

    -- Clear first: the partial unique index is checked row by row.
    UPDATE public.adventure_outfit o SET is_default = false
     WHERE o.account_id = v_owner.account_id AND o.is_default AND o.slot <> p_slot;
    UPDATE public.adventure_outfit o SET is_default = true
     WHERE o.account_id = v_owner.account_id AND o.slot = p_slot;

    RETURN 'ok';
END;
$$;

-- The look of the player's last save in the game, for "import from game".
-- 'ok' with the look | 'not_found' | 'no_look' (never saved since migration
-- 11, or never played).
CREATE OR REPLACE FUNCTION accounts.outfit_import_look(p_username text)
RETURNS TABLE (result text, gender int, kits jsonb, colours jsonb, worn jsonb, saved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE WHEN a.id IS NULL THEN 'not_found' WHEN l.account_id IS NULL THEN 'no_look' ELSE 'ok' END,
           l.gender, l.kits::jsonb, l.colours::jsonb, l.worn::jsonb, l.updated_at
      FROM (SELECT 1) one
      LEFT JOIN public.account a ON a.username = p_username
      LEFT JOIN public.account_look l ON l.account_id = a.id AND l.profile = accounts.public_profile();
$$;

-- ---------------------------------------------------------------------------
-- the public read
-- ---------------------------------------------------------------------------

-- The default look behind each name, for drawing chatheads on public pages:
-- a log's header, and everyone beside their posts and replies. A name with no
-- default outfit, or no account, has no row. At most 100 names a call.
CREATE OR REPLACE FUNCTION accounts.outfit_default_looks(p_usernames text[])
RETURNS TABLE (username text, gender int, kits jsonb, colours jsonb, worn jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.username, o.gender, o.kits::jsonb, o.colours::jsonb, o.worn::jsonb
      FROM public.account a
      JOIN public.adventure_outfit o ON o.account_id = a.id AND o.is_default
     WHERE a.username = ANY ((p_usernames)[1:100])
     ORDER BY a.username;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Six functions on the `website` role, and still no privilege of any kind on
-- schema public: `select * from adventure_outfit` as website is refused. The
-- three helpers are granted to nobody.

REVOKE ALL ON FUNCTION accounts.outfit_ints_ok(int[], int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.outfit_look_ok(int, int[], int[], int[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.outfit_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.outfits(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.outfit_save(text, int, text, int, int[], int[], int[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.outfit_delete(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.outfit_set_default(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.outfit_import_look(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.outfit_default_looks(text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.outfits(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.outfit_save(text, int, text, int, int[], int[], int[]) TO website;
GRANT EXECUTE ON FUNCTION accounts.outfit_delete(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.outfit_set_default(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.outfit_import_look(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.outfit_default_looks(text[]) TO website;

-- rollback:
--
-- Drops everything this migration made, outfits included. The site's outfit
-- editor answers "unavailable" and chatheads fall back to none.
--
-- DROP FUNCTION IF EXISTS accounts.outfit_default_looks(text[]);
-- DROP FUNCTION IF EXISTS accounts.outfit_import_look(text);
-- DROP FUNCTION IF EXISTS accounts.outfit_set_default(text, int);
-- DROP FUNCTION IF EXISTS accounts.outfit_delete(text, int);
-- DROP FUNCTION IF EXISTS accounts.outfit_save(text, int, text, int, int[], int[], int[]);
-- DROP FUNCTION IF EXISTS accounts.outfits(text);
-- DROP FUNCTION IF EXISTS accounts.outfit_owner(text);
-- DROP FUNCTION IF EXISTS accounts.outfit_look_ok(int, int[], int[], int[]);
-- DROP FUNCTION IF EXISTS accounts.outfit_ints_ok(int[], int, int, int);
-- DROP TABLE IF EXISTS "adventure_outfit";
