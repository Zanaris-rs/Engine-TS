-- 5_economy_categories: the rest of the census, made public.
--
-- Migration 4 wrote `economy_snapshot.items` - a {item_id: count} map of every
-- item id in every permanent inventory of every save - and then published none
-- of it. `accounts.public_economy(p_days)` returns `players`, `coins` and
-- `tracked`, the fifteen rares named in `data/config/economy.json`, and stops
-- there. So /economy could say how many partyhats exist and could not say how
-- much iron ore does, although the census had counted it an hour ago.
--
-- This migration adds no table and changes no row. It adds two read functions
-- so the page can show the whole count, under the same rules as everything
-- else in `accounts`: SECURITY DEFINER over tables the `website` role has no
-- grant on, `profile` pinned to `accounts.public_profile()` so the caller
-- cannot choose what is public, and REVOKE before GRANT.
--
--   public_economy_latest      the newest snapshot, whole, including `items`.
--   public_economy_group_range the low and the high of each category's total
--                              across a window.
--
-- ## What this publishes, said plainly
--
-- `items` is every id, not the tracked fifteen. After this migration the exact
-- number of every object in the game is public, which is the point - a total
-- nobody can check is a claim, not a count - but it has a consequence worth
-- writing down rather than discovering: an item that exists once tells the
-- world something about the one account holding it, and anything unreleased
-- sitting in a staff bank is now visible. No account is named, here or
-- anywhere in this file; that property is unchanged. What changes is that the
-- objects themselves are all countable.
--
-- ## Why the categories are an argument and not a column
--
-- "Ores", "Runes", "Hides & leather" are a decision about how to present a
-- census, not a fact about the game. The engine's own `category=` field is a
-- script-trigger tag - doors, npc kinds, weapon classes - and most objects have
-- none. So the grouping lives in the website's `lib/items/groups.ts` and
-- arrives here as `p_groups`, and renaming a category is an edit to a TypeScript
-- file rather than a migration. The census tool stays as it is: it counts
-- objects and knows nothing about how they will be read.

-- ---------------------------------------------------------------------------
-- the newest census, whole
-- ---------------------------------------------------------------------------

-- One row, no window argument. The window selector on /economy changes the low
-- and high lines and never the current figures - "how much iron ore exists" has
-- one answer whichever window is being shown - so all four tabs read this same
-- row and the page has one place to be wrong about "now".
--
-- No LIMIT clause beyond the 1: this is the only function in `accounts` that
-- returns an unbounded jsonb, and the bound is the game's object count rather
-- than anything a caller passes.
CREATE OR REPLACE FUNCTION accounts.public_economy_latest()
RETURNS TABLE (taken_at timestamptz, players int, coins bigint, items jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT es.taken_at, es.players, es.coins, es.items
    FROM public.economy_snapshot es
    WHERE es.profile = accounts.public_profile()
    ORDER BY es.taken_at DESC, es.id DESC
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- what each category's total has been, at its lowest and highest
-- ---------------------------------------------------------------------------

-- p_groups is {"ores": [438, 440, ...], "runes": [...], ...}; the return is one
-- row per group plus one for '*', the ids no group named.
--
-- ## Why '*' is computed here and not on the website
--
-- Minima and maxima are not additive. `min(other)` is not `min(everything)`
-- minus `max(named)`, and a page that derived it that way would print a bound
-- and call it a figure - on the one page whose entire purpose is being
-- checkable from outside the server. The residual is therefore summed per
-- snapshot in the same pass as everything else, where it is exact and costs
-- nothing extra.
--
-- ## Why the query is shaped like this
--
-- The obvious version - a group at a time, each scanning `items` - is snapshots
-- x ids x groups, which at ninety days is tens of millions of jsonb lookups.
-- Each snapshot's map is instead expanded exactly once and joined to a
-- flattened id -> group table, so the cost is snapshots x ids through one hash
-- join, and the unmatched ids fall into '*' by coalesce rather than by a second
-- pass.
--
-- Three details that are correctness rather than tidiness:
--
--   DISTINCT ON  an id named by two groups is counted once, so the groups still
--                sum to the census however wrong the caller's map is. The map
--                is meant to be a partition and the website has a test saying
--                so; this is what keeps the arithmetic honest if that test is
--                wrong.
--   CROSS JOIN   a group that held nothing at some hour has a low of 0, not no
--                low. Without filling every group against every snapshot, a
--                category that was empty for a week would report the low of the
--                hours it happened to exist in. `named` is the caller's own
--                keys and not the ids that survived DISTINCT ON, so every group
--                asked about gets a row - a category whose items do not exist
--                yet answers 0 and 0, which is a figure, rather than answering
--                nothing, which the page would have to render as a gap.
--   the cast     a count that is not a number raises rather than being skipped.
--                A census row this function cannot read must fail the page, not
--                quietly lower a high.
--
-- Same clamp and same ceiling as public_economy: 1..90 days, 2400 snapshots.
CREATE OR REPLACE FUNCTION accounts.public_economy_group_range(p_days int, p_groups jsonb)
RETURNS TABLE (grp text, low bigint, high bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH win AS (
        SELECT es.id, es.items
        FROM public.economy_snapshot es
        WHERE es.profile = accounts.public_profile()
          AND es.taken_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
        ORDER BY es.taken_at DESC, es.id DESC
        LIMIT 2400
    ),
    member AS (
        SELECT DISTINCT ON (i.value) i.value AS item_id, g.key AS grp
        FROM jsonb_each(coalesce(p_groups, '{}'::jsonb)) g
        CROSS JOIN LATERAL jsonb_array_elements_text(g.value) i
        WHERE jsonb_typeof(g.value) = 'array'
          AND g.key <> '*'
          AND i.value ~ '^[0-9]+$'
        ORDER BY i.value, g.key
    ),
    per AS (
        SELECT w.id, coalesce(m.grp, '*') AS grp, sum(v.value::bigint) AS total
        FROM win w
        CROSS JOIN LATERAL jsonb_each_text(w.items) v
        LEFT JOIN member m ON m.item_id = v.key
        GROUP BY w.id, coalesce(m.grp, '*')
    ),
    named AS (
        SELECT g.key AS grp
        FROM jsonb_each(coalesce(p_groups, '{}'::jsonb)) g
        WHERE jsonb_typeof(g.value) = 'array' AND g.key <> '*'
        UNION
        SELECT '*'
    ),
    filled AS (
        SELECT n.grp, coalesce(p.total, 0) AS total
        FROM win w
        CROSS JOIN named n
        LEFT JOIN per p ON p.id = w.id AND p.grp = n.grp
    )
    SELECT f.grp, min(f.total)::bigint, max(f.total)::bigint
    FROM filled f
    GROUP BY f.grp;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Two more functions on the `website` role, taking it to thirty-four, and still
-- no privilege of any kind on schema public: `select * from economy_snapshot`
-- as website is refused after this migration exactly as it was before it.

REVOKE ALL ON FUNCTION accounts.public_economy_latest() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.public_economy_group_range(int, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.public_economy_latest() TO website;
GRANT EXECUTE ON FUNCTION accounts.public_economy_group_range(int, jsonb) TO website;

-- rollback:
--
-- Nothing was created but these two functions, so dropping them restores
-- migration 4 exactly. /economy falls back to its tracked-item table on the
-- next revalidation; no row is lost, because no row was written.
--
-- DROP FUNCTION IF EXISTS accounts.public_economy_group_range(int, jsonb);
-- DROP FUNCTION IF EXISTS accounts.public_economy_latest();
