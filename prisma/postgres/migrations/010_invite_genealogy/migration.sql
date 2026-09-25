-- 10_invite_genealogy: the whole invite tree, for staff.
--
-- The owner asked for a "server tree" on 2026-09-23: who invited whom across
-- every account, with the progenitors - the accounts nobody invited - at the
-- top. The website draws it at `/staff/invites/genealogy`.
--
-- Migration 6 made who-invited-whom private to the two players and staff, and
-- this keeps it that way: the one new function answers staff and nobody else.
-- A public tree, if it ever comes, is a separate function with fewer columns.
--
-- ## What this adds
--
-- One function, `accounts.staff_invite_genealogy(p_actor)`: one row per
-- account, with the citizen number of the account whose link it claimed.
-- `staff_invite_tree` already answers the same question one account at a
-- time, a single step up and down; this is the same join over everybody, flat,
-- and the website builds the tree.
--
--   - `invited_by` is null for a progenitor: the accounts made before
--     migration 6 and any made at the engine's CLI since.
--   - `joined_at` is the claim time for an invited account, and
--     `registration_date` for a progenitor.
--   - An account claims at most one link (`register_with_invite` makes the
--     account and claims in one statement), but nothing in the table says so,
--     so the earliest claim wins rather than an account appearing twice.
--
-- No table, no row, no change to anything the game server does, so there is
-- no fleet deploy. The `website` role goes from fifty-two functions to
-- fifty-three.
--
-- No LIMIT: a cut list would turn the accounts past the cut's children into
-- false progenitors. One short row per account is small at any size this
-- server will reach.

CREATE OR REPLACE FUNCTION accounts.staff_invite_genealogy(p_actor text)
RETURNS TABLE (username text, citizen_number int, invited_by int, joined_at timestamptz,
               invites_enabled boolean, banned boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH claim AS (
        SELECT DISTINCT ON (i.claimed_by_account_id)
               i.claimed_by_account_id AS account_id, i.created_by_account_id AS inviter_id, i.claimed_at
        FROM public.invite i
        WHERE i.claimed_by_account_id IS NOT NULL
        ORDER BY i.claimed_by_account_id, i.claimed_at, i.id
    )
    SELECT a.username,
           a.id,
           c.inviter_id,
           coalesce(c.claimed_at, a.registration_date),
           a.invites_enabled,
           coalesce(a.banned_until > now(), false)
    FROM public.account a
    LEFT JOIN claim c ON c.account_id = a.id
    WHERE accounts.is_staff(p_actor)
    ORDER BY a.id;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION accounts.staff_invite_genealogy(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.staff_invite_genealogy(text) TO website;

-- rollback:
--
-- Nothing reads this but the genealogy page, which says the records are
-- unavailable without it.
--
-- DROP FUNCTION IF EXISTS accounts.staff_invite_genealogy(text);
