-- 019_public_genealogy: the invite tree, for everyone.
--
-- The owner asked on 2026-10-15 for the genealogy to be a public page,
-- linked from the main menu, shown to everyone from the day it ships.
-- Migration 6 made who-invited-whom private to the two players and staff,
-- and migration 10 kept the tree staff-only while saying a public one would
-- be "a separate function with fewer columns". This is that function.
--
-- ## What this adds
--
-- One function, `accounts.public_invite_genealogy()`: one row per account,
-- with the citizen number of the account whose link it claimed. It is
-- `staff_invite_genealogy` without the actor and without the staff columns:
--
--   - kept: `username`, `citizen_number`, `invited_by`, `joined_at`;
--   - dropped: `invites_enabled` (a staff switch, nobody else's business) and
--     `banned` (the Ban Record already says who is banned, with its reason).
--
-- `invited_by` is null for a progenitor; `joined_at` is the claim time for an
-- invited account and `registration_date` for a progenitor; the earliest
-- claim wins, as in migration 10. No LIMIT, for migration 10's reason.
--
-- No table, no row, no change to anything the game server does, so there is
-- no fleet deploy. The `website` role goes from one hundred and seven
-- functions to one hundred and eight.

CREATE OR REPLACE FUNCTION accounts.public_invite_genealogy()
RETURNS TABLE (username text, citizen_number int, invited_by int, joined_at timestamptz)
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
           coalesce(c.claimed_at, a.registration_date)
    FROM public.account a
    LEFT JOIN claim c ON c.account_id = a.id
    ORDER BY a.id;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION accounts.public_invite_genealogy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounts.public_invite_genealogy() TO website;

-- rollback:
--
-- Nothing reads this but the public genealogy page, which says the records
-- are unavailable without it. The staff page keeps its own function.
--
-- DROP FUNCTION IF EXISTS accounts.public_invite_genealogy();
