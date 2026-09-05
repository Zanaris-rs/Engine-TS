-- 4_evidence_and_records: macro report evidence, the public punishment record,
-- staff item spawns and the economy census.
--
-- Same shape as 2_website_login and 3_message_centre. No foreign keys, RLS on
-- with no policies, no grant of any kind on schema public or the tables in it:
-- the website reaches these rows only through the SECURITY DEFINER functions
-- that task M4b appends to the bottom of this file, and a leaked `website`
-- credential can still do nothing with `select * from report_input`.
--
-- Why each table exists:
--
--   report_input / report_chat  A Report Abuse row used to be a sentence with
--                               no evidence behind it. `report.uuid` is a
--                               world-generated key carried by both the login
--                               server (the report row) and the logger server
--                               (the evidence), so the two hub processes need
--                               no ordering between them and nothing has to
--                               join a time window across the log tables.
--                               Evidence lives 30 days, or until staff dismiss
--                               the report; reap() enforces both in M4b.
--   punishment                  A permanent, public record of every ban and
--                               mute: what happened, when, until when, and
--                               whether it was lifted. The issuing moderator's
--                               id is stored but never leaves the database -
--                               the public read function shows "a moderator"
--                               or "automated" and nothing more.
--   staff_spawn                 Every item a staff member creates on a
--                               production world, so the economy census can
--                               say "added by staff" instead of leaving a
--                               step in the totals unexplained.
--   economy_snapshot / _flow    The hourly census of every save file: totals
--                               plus a per-item map, and the per-item delta
--                               against the previous snapshot. Nothing here
--                               names an account; the flow rows say an item
--                               entered or left the game, not who holds it.
--
-- `report.uuid` is nullable and its index is not unique: every report written
-- before this migration has no uuid, and one uuid legitimately covers several
-- reports when more than one player reports the same macroer inside the same
-- capture window.

-- ---------------------------------------------------------------------------
-- report: the evidence key, who was reported, and the resolution trail
-- ---------------------------------------------------------------------------

-- All nullable, for the same reason reporter_account_id and world are in
-- 3_message_centre: the rows already in this table know none of it, and the
-- offender ids are only resolvable when the offender has an account (and, for
-- the session and coord, when they were online at the time).
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "uuid" TEXT;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "offender_account_id" INTEGER;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "offender_session_uuid" TEXT;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "offender_coord" INTEGER;

-- resolution is actioned | dismissed | watch, null while the report is open.
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMPTZ(3);
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "resolution" TEXT;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "resolved_by_account_id" INTEGER;
ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "staff_note" TEXT;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

-- One row per input chunk the logger server was handed. kind is ring (a chunk
-- that had already rotated out of the player's ring when the report arrived)
-- or live (a chunk captured after it); client is web | java; seq orders the
-- chunks within one report and data is the engine's own record framing,
-- decoded by the website, never by the database.
CREATE TABLE IF NOT EXISTS "report_input" (
    "id" SERIAL NOT NULL,
    "report_uuid" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "flushed_at" TIMESTAMPTZ(3) NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "report_input_pkey" PRIMARY KEY ("id")
);

-- The offender's own chat in the report window, copied out of public_chat and
-- private_chat before the hourly sweep deletes it. kind is public or
-- private_sent; to_username is null on a public row.
CREATE TABLE IF NOT EXISTS "report_chat" (
    "id" SERIAL NOT NULL,
    "report_uuid" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "to_username" TEXT,
    "coord" INTEGER NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "report_chat_pkey" PRIMARY KEY ("id")
);

-- kind is ban | mute. `until` null is permanent. automated is true when the
-- engine issued it rather than a person, and issued_by_account_id is then
-- null; neither is ever shown to the public. note is the optional one-line
-- public explanation, lifted_at/lifted_by are set when it is reversed - the
-- row itself is never deleted, which is the point of a public record.
CREATE TABLE IF NOT EXISTS "punishment" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" TIMESTAMPTZ(3),
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "issued_by_account_id" INTEGER,
    "note" TEXT,
    "lifted_at" TIMESTAMPTZ(3),
    "lifted_by_account_id" INTEGER,

    CONSTRAINT "punishment_pkey" PRIMARY KEY ("id")
);

-- target_account_id is null when the cheat named someone the login server
-- could not resolve to an account; the spawn still happened, so the row is
-- still written.
CREATE TABLE IF NOT EXISTS "staff_spawn" (
    "id" SERIAL NOT NULL,
    "staff_account_id" INTEGER NOT NULL,
    "target_account_id" INTEGER,
    "item_id" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,
    "world" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_spawn_pkey" PRIMARY KEY ("id")
);

-- items is the whole census as {item_id: count}; tracked is the subset named
-- in data/config/economy.json, stored beside it so the public page needs no
-- second lookup and so a later edit to that list cannot rewrite history.
-- coins is bigint: item 995 across every save passes 2^31 long before the
-- player count does anything interesting.
CREATE TABLE IF NOT EXISTS "economy_snapshot" (
    "id" SERIAL NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile" TEXT NOT NULL,
    "players" INTEGER NOT NULL,
    "coins" BIGINT NOT NULL,
    "items" JSONB NOT NULL,
    "tracked" JSONB NOT NULL,

    CONSTRAINT "economy_snapshot_pkey" PRIMARY KEY ("id")
);

-- delta is signed: positive entered the game since the previous snapshot,
-- negative left it.
CREATE TABLE IF NOT EXISTS "economy_flow" (
    "id" SERIAL NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile" TEXT NOT NULL,
    "item_id" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,

    CONSTRAINT "economy_flow_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------

-- Not unique: one uuid covers every report filed against the same offender
-- inside one capture window, and the rows written before this migration have
-- no uuid at all.
CREATE INDEX IF NOT EXISTS "report_uuid_idx" ON "report"("uuid");
CREATE INDEX IF NOT EXISTS "report_offender_account_id_timestamp_idx" ON "report"("offender_account_id", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS "report_input_report_uuid_seq_idx" ON "report_input"("report_uuid", "seq");
CREATE INDEX IF NOT EXISTS "report_chat_report_uuid_at_idx" ON "report_chat"("report_uuid", "at");

-- The log tables have been unindexed since 0_init, and they now have both a
-- reader and a reaper. The bare timestamp index is the retention sweep's
-- (1 hour for chat, 7 days for wealth); the compound ones are how the evidence
-- functions find one player's rows inside a report window.
CREATE INDEX IF NOT EXISTS "session_wealth_timestamp_idx" ON "session_wealth"("timestamp");
CREATE INDEX IF NOT EXISTS "session_wealth_session_uuid_timestamp_idx" ON "session_wealth"("session_uuid", "timestamp");
CREATE INDEX IF NOT EXISTS "public_chat_timestamp_idx" ON "public_chat"("timestamp");
CREATE INDEX IF NOT EXISTS "public_chat_session_uuid_timestamp_idx" ON "public_chat"("session_uuid", "timestamp");
CREATE INDEX IF NOT EXISTS "private_chat_timestamp_idx" ON "private_chat"("timestamp");
CREATE INDEX IF NOT EXISTS "private_chat_account_id_timestamp_idx" ON "private_chat"("account_id", "timestamp");

CREATE INDEX IF NOT EXISTS "punishment_issued_at_idx" ON "punishment"("issued_at" DESC);
CREATE INDEX IF NOT EXISTS "punishment_account_id_idx" ON "punishment"("account_id");
CREATE INDEX IF NOT EXISTS "staff_spawn_created_at_idx" ON "staff_spawn"("created_at" DESC);
CREATE INDEX IF NOT EXISTS "economy_snapshot_profile_taken_at_idx" ON "economy_snapshot"("profile", "taken_at" DESC);
CREATE INDEX IF NOT EXISTS "economy_flow_profile_taken_at_idx" ON "economy_flow"("profile", "taken_at" DESC);

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------
--
-- On, with no policies, matching 0_init and 3_message_centre: nothing reaches
-- these rows except through a SECURITY DEFINER function running as the owner.

ALTER TABLE "report_input" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_chat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "punishment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_spawn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "economy_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "economy_flow" ENABLE ROW LEVEL SECURITY;

-- `input_report` is 0_init's table and is not the same thing as `report_input`
-- above. Nothing reads it, nothing has written to it since the logger server
-- was disabled, and migration 4 neither touches nor replaces it; the names are
-- an accident of history, so do not reach for the wrong one.

-- === functions (task M4b) ===
--
-- Everything below this line is the SQL API: the staff read functions, the two
-- verbs that close a report and undo a punishment, the four public reads, the
-- REVOKE and GRANT block, the replacement reap(), and last the commented
-- `-- rollback:` block - drop the functions, the indexes and the tables this
-- file creates, drop the columns it adds to report, and restore the previous
-- staff_reports() and reap(). Commented, because a rollback is a decision
-- someone makes at a prompt with the row counts in front of them, not
-- something a migration runner can take back.
--
-- This file is applied once, as a whole: nothing above has run against any
-- database yet either.

-- ---------------------------------------------------------------------------
-- internal helpers: NOT granted to website
-- ---------------------------------------------------------------------------

-- Who a report is about, as an account id.
--
-- The login server resolves this when it writes the row, so `offender_account_id`
-- is almost always the answer. The fallback is for the rows it could not: a
-- report filed against somebody who had already logged out on another world,
-- or any report written before migration 4. `lower(replace(name, ' ', '_'))` is
-- toSafeName's rule in SQL - base37 lowercases and turns spaces into
-- underscores, and `report.offender` is the display name the client sent.
--
-- Three functions need this and none of them may disagree about it, which is
-- why it is a helper rather than three copies of a LATERAL. Granted to nobody,
-- like is_staff: it is called by SECURITY DEFINER functions while they are
-- already running as the owner.
CREATE OR REPLACE FUNCTION accounts.report_offender(p_id int) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.id
    FROM public.report r
    JOIN public.account a
      ON a.id = r.offender_account_id
      OR (r.offender_account_id IS NULL AND a.username = lower(replace(r.offender, ' ', '_')))
    WHERE r.id = p_id
    LIMIT 1;
$$;

-- Which profile `/economy` is about.
--
-- One database serves every profile a fleet runs, and a public page that added
-- a beta world's coins to a live world's would be wrong in a way nobody could
-- see. This is deliberately a constant in a function granted to nobody, and
-- deliberately *not* `current_setting('app.public_profile')`: a GUC is settable
-- for the session by whoever holds the connection, so `website` could have
-- pointed the public page at any profile it liked by sending one SET before the
-- read. The point of these functions is that the caller cannot choose what is
-- public, and a knob the caller can turn is not a smaller version of that - it
-- is the opposite of it.
--
-- Changing it is a migration, which is the right weight for the decision.
CREATE OR REPLACE FUNCTION accounts.public_profile() RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT 'main'::text;
$$;

-- ---------------------------------------------------------------------------
-- the reports list, and one report with its evidence
-- ---------------------------------------------------------------------------

-- 3_message_centre's staff_reports plus the three columns the evidence work
-- adds: the uuid the world generated, whether anything was actually captured
-- under it, and how the report was closed.
--
-- Dropped rather than replaced: CREATE OR REPLACE cannot change a function's
-- return type, and a RETURNS TABLE with three more columns is a different
-- composite type. The grant goes with it and is re-issued at the bottom of
-- this file, which is the reason every grant in migration 4 is written out
-- again rather than assumed.
DROP FUNCTION IF EXISTS accounts.staff_reports(text, timestamptz);

CREATE OR REPLACE FUNCTION accounts.staff_reports(p_actor text, p_since timestamptz)
RETURNS TABLE (id int, reported_at timestamptz, world int, reporter text,
               offender text, reason int, coord int, session_uuid text,
               uuid text, has_evidence boolean, resolution text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.id, r.timestamp, r.world, coalesce(reporter.username, ''),
           r.offender, r.reason, r.coord, r.session_uuid,
           coalesce(r.uuid, ''),
           r.uuid IS NOT NULL
           AND (EXISTS (SELECT 1 FROM public.report_input ri WHERE ri.report_uuid = r.uuid)
             OR EXISTS (SELECT 1 FROM public.report_chat rc WHERE rc.report_uuid = r.uuid)),
           r.resolution
    FROM public.report r
    LEFT JOIN public.account reporter ON reporter.id = r.reporter_account_id
    WHERE accounts.is_staff(p_actor)
      AND r.timestamp > coalesce(p_since, now() - interval '7 days')
    ORDER BY r.timestamp DESC
    LIMIT 500;
$$;

-- One report, everything the detail page puts in its header, and nothing that
-- would name an address.
--
-- `same_ip_as_reporter` is the whole of what leaves the database about an ip:
-- a boolean, or null when there is no login on one side to compare. Whether
-- two people are behind one address decides how a moderator reads a report -
-- it is the difference between a witness and a second account - and the
-- address itself decides nothing, so the address itself does not leave.
--
-- Empty for a report that does not exist and empty for an actor who is not
-- staff, deliberately: the page 404s on both and cannot tell them apart, which
-- is the answer a probe deserves.
--
-- `ban_punishment_id` and `mute_punishment_id` are the rows behind an offender
-- who is under one right now (never lifted, not yet expired), because
-- staff_lift takes a punishment id and this page is where a moderator lifts.
-- Null means there is nothing in force of that kind - or that the ban predates
-- migration 4 and has only an `account.banned_until` behind it, which the page
-- says out loud rather than guessing at.
CREATE OR REPLACE FUNCTION accounts.staff_report(p_actor text, p_id int)
RETURNS TABLE (id int, uuid text, reported_at timestamptz, world int,
               reporter text, offender text, reason int, coord int, session_uuid text,
               offender_registered boolean, offender_banned_until timestamptz,
               offender_muted_until timestamptz, offender_world int,
               window_from timestamptz, window_to timestamptz, input_chunks int,
               same_ip_as_reporter boolean, offender_logins_24h int,
               resolved_at timestamptz, resolution text, resolved_by text, staff_note text,
               ban_punishment_id int, mute_punishment_id int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.id, coalesce(r.uuid, ''), r.timestamp, r.world,
           coalesce(reporter.username, ''), r.offender, r.reason, r.coord, r.session_uuid,
           offender.id IS NOT NULL, offender.banned_until, offender.muted_until,
           offender_session.world,
           r.timestamp - interval '30 minutes',
           r.timestamp + interval '15 minutes',
           (SELECT count(*)::int FROM public.report_input ri WHERE ri.report_uuid = r.uuid),
           CASE WHEN reporter_session.ip IS NULL OR offender_session.ip IS NULL THEN NULL
                ELSE reporter_session.ip = offender_session.ip END,
           CASE WHEN offender.id IS NULL THEN NULL ELSE
               (SELECT count(*)::int FROM public.session s
                 WHERE s.account_id = offender.id
                   AND s.timestamp > r.timestamp - interval '24 hours'
                   AND s.timestamp <= r.timestamp) END,
           r.resolved_at, r.resolution, coalesce(resolver.username, ''), coalesce(r.staff_note, ''),
           (SELECT p.id FROM public.punishment p
             WHERE p.account_id = offender.id AND p.kind = 'ban'
               AND p.lifted_at IS NULL AND (p.until IS NULL OR p.until > now())
             ORDER BY p.issued_at DESC, p.id DESC LIMIT 1),
           (SELECT p.id FROM public.punishment p
             WHERE p.account_id = offender.id AND p.kind = 'mute'
               AND p.lifted_at IS NULL AND (p.until IS NULL OR p.until > now())
             ORDER BY p.issued_at DESC, p.id DESC LIMIT 1)
    FROM public.report r
    LEFT JOIN public.account reporter ON reporter.id = r.reporter_account_id
    LEFT JOIN public.account resolver ON resolver.id = r.resolved_by_account_id
    LEFT JOIN public.account offender ON offender.id = accounts.report_offender(r.id)
    LEFT JOIN public.session reporter_session ON reporter_session.uuid = r.session_uuid
    -- The session the offender was on: the one the report names, or - when the
    -- world could not name one - their newest login before the report.
    --
    -- Both branches insist the session belongs to the offender. The named one
    -- has to as well: `report.offender_session_uuid` is written by a world that
    -- guessed, or by the login server's own newest-session lookup, and a uuid
    -- that turns out to be somebody else's would put a stranger's world on the
    -- page and - worse - hand their address to same_ip_as_reporter. When the
    -- offender resolved to no account at all there is nothing to check it
    -- against, and the named session is taken as it stands.
    LEFT JOIN LATERAL (
        SELECT s.world, s.ip
        FROM public.session s
        WHERE (r.offender_session_uuid IS NOT NULL AND s.uuid = r.offender_session_uuid
               AND (offender.id IS NULL OR s.account_id = offender.id))
           OR (r.offender_session_uuid IS NULL AND offender.id IS NOT NULL
               AND s.account_id = offender.id AND s.timestamp <= r.timestamp)
        ORDER BY s.timestamp DESC
        LIMIT 1
    ) offender_session ON true
    WHERE accounts.is_staff(p_actor) AND r.id = p_id;
$$;

-- The captured input, as the engine framed it. `bytea` becomes base64 here
-- rather than over the wire: the decoder on the website reads base64, and
-- postgres's own hex-escaped bytea would be twice the size and a second format
-- to agree about.
--
-- 200 chunks is a ring dump (16) plus a full 15-minute tail at one chunk a
-- minute, several times over. A report that produced more than that has a
-- flooding client behind it, and the marker record in the stream says so.
CREATE OR REPLACE FUNCTION accounts.staff_report_input(p_actor text, p_id int)
RETURNS TABLE (seq int, kind text, client text, started_at timestamptz,
               flushed_at timestamptz, data_base64 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT ri.seq, ri.kind, ri.client, ri.started_at, ri.flushed_at, encode(ri.data, 'base64')
    FROM public.report r
    JOIN public.report_input ri ON ri.report_uuid = r.uuid
    WHERE accounts.is_staff(p_actor) AND r.id = p_id
    ORDER BY ri.seq, ri.id
    LIMIT 200;
$$;

-- The offender's own words in the window: what they said out loud and the
-- private messages they sent, never what was said to them. The logger server
-- copied these rows out of public_chat and private_chat before the friend
-- server's hourly sweep took them; this is the only place they still exist.
--
-- Ordered by time, because the page renders them in the order they arrive and
-- marks the ones after the report instant rather than re-sorting.
CREATE OR REPLACE FUNCTION accounts.staff_report_chat(p_actor text, p_id int)
RETURNS TABLE (at timestamptz, kind text, to_username text, coord int, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT rc.at, rc.kind, coalesce(rc.to_username, ''), rc.coord, rc.message
    FROM public.report r
    JOIN public.report_chat rc ON rc.report_uuid = r.uuid
    WHERE accounts.is_staff(p_actor) AND r.id = p_id
    ORDER BY rc.at, rc.id
    LIMIT 500;
$$;

-- What the offender gained and lost in the window.
--
-- These are not evidence rows and nothing copied them: `session_wealth` is
-- written for everybody and kept seven days, and this reads it by the
-- offender's sessions inside the report's window while it is still there. A
-- report older than a week answers empty, which is why the page treats a
-- failure here as a missing block rather than a missing report.
CREATE OR REPLACE FUNCTION accounts.staff_report_wealth(p_actor text, p_id int)
RETURNS TABLE (at timestamptz, event_type int, coord int, items text, value int,
               counterpart text, counterpart_items text, counterpart_value int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT sw.timestamp, sw.event_type, sw.coord, sw.account_items, sw.account_value,
           coalesce(sw.recipient_session, ''), coalesce(sw.recipient_items, ''), sw.recipient_value
    FROM public.report r
    JOIN public.session s ON s.account_id = accounts.report_offender(r.id)
    JOIN public.session_wealth sw ON sw.session_uuid = s.uuid
    WHERE accounts.is_staff(p_actor)
      AND r.id = p_id
      AND sw.timestamp >= r.timestamp - interval '30 minutes'
      AND sw.timestamp <= r.timestamp + interval '15 minutes'
    ORDER BY sw.timestamp, sw.id
    LIMIT 500;
$$;

-- The staff search box: one player, newest first, and never further back than
-- the seven days the rows live. A `p_since` from before that is raised to it
-- rather than honoured - a wider window is not a bigger answer, it is the same
-- answer under a heading that lies about what is missing.
CREATE OR REPLACE FUNCTION accounts.staff_wealth(p_actor text, p_username text, p_since timestamptz)
RETURNS TABLE (at timestamptz, event_type int, coord int, items text, value int,
               counterpart text, counterpart_items text, counterpart_value int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT sw.timestamp, sw.event_type, sw.coord, sw.account_items, sw.account_value,
           coalesce(sw.recipient_session, ''), coalesce(sw.recipient_items, ''), sw.recipient_value
    FROM public.account a
    JOIN public.session s ON s.account_id = a.id
    JOIN public.session_wealth sw ON sw.session_uuid = s.uuid
    WHERE accounts.is_staff(p_actor)
      AND a.username = lower(replace(coalesce(p_username, ''), ' ', '_'))
      AND sw.timestamp > greatest(coalesce(p_since, now() - interval '7 days'),
                                  now() - interval '7 days')
    ORDER BY sw.timestamp DESC, sw.id DESC
    LIMIT 500;
$$;

-- ---------------------------------------------------------------------------
-- the two verbs that close a report and undo a punishment
-- ---------------------------------------------------------------------------

-- 'ok' | 'forbidden' | 'bad_credentials' | 'rate_limited' | 'not_found' | 'invalid'.
--
-- **`dismissed` deletes the evidence**, here, in the same statement: every
-- report_input chunk and every report_chat line filed under this report's
-- uuid, permanently. That is the owner's decision and it is why this verb
-- re-types a password the way staff_notice does - the compare-and-set against
-- the actor's own bcrypt hash, computed by the site against the actor's own
-- salt, so a leaked `website` credential cannot throw a macroer's mouse trail
-- away on a moderator's behalf.
--
-- One uuid can cover several reports of the same macroer inside one capture
-- window, so dismissing one of them deletes the evidence the others were
-- reading. That is the same evidence about the same fifteen minutes of the
-- same person: it is one capture with several reports pointing at it, and
-- deleting half of it is not a thing the tables can express. The moderator
-- guide says so.
CREATE OR REPLACE FUNCTION accounts.staff_report_resolve(p_actor text, p_candidate_hash text,
                                                         p_id int, p_resolution text, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor_id int; v_password text; v_uuid text; v_exists boolean; v_note text;
BEGIN
    IF NOT accounts.is_staff(p_actor) THEN RETURN 'forbidden'; END IF;

    -- staff_notice's bucket rule: the same ten-failures-per-fifteen-minutes
    -- limiter as website login, in a bucket of its own so mistyping a password
    -- into a form you are already signed in to cannot lock you out of signing
    -- in. There is no ip to pass - the route calls this with the session's
    -- username only - so the prefixed name stands in for one.
    IF accounts.throttled('resolve:' || p_actor, p_actor) THEN RETURN 'rate_limited'; END IF;

    SELECT a.id, a.password INTO v_actor_id, v_password FROM public.account a WHERE a.username = p_actor;

    IF p_candidate_hash IS NULL OR length(p_candidate_hash) <> 60
       OR v_password IS NULL OR v_password <> p_candidate_hash THEN
        PERFORM accounts.record_failure('resolve:' || p_actor, p_actor);
        RETURN 'bad_credentials';
    END IF;

    -- Trimmed before it is measured, and the same value that gets stored: the
    -- cap is on the note, and a paste that arrives with a screenful of
    -- whitespace on the end is not a longer note. 1000 is STAFF_NOTE_MAX in
    -- the website's lib/staff/format.ts, which refuses it a moment earlier
    -- with a message naming the field; this is the authority.
    v_note := nullif(btrim(coalesce(p_note, '')), '');

    IF p_resolution IS NULL OR p_resolution NOT IN ('actioned', 'dismissed', 'watch')
       OR (v_note IS NOT NULL AND length(v_note) > 1000) THEN
        RETURN 'invalid';
    END IF;

    SELECT true, r.uuid INTO v_exists, v_uuid FROM public.report r WHERE r.id = p_id;
    IF v_exists IS NULL THEN RETURN 'not_found'; END IF;

    UPDATE public.report
       SET resolved_at = now(),
           resolution = p_resolution,
           resolved_by_account_id = v_actor_id,
           staff_note = v_note
     WHERE id = p_id;

    IF p_resolution = 'dismissed' AND v_uuid IS NOT NULL THEN
        DELETE FROM public.report_input WHERE report_uuid = v_uuid;
        DELETE FROM public.report_chat WHERE report_uuid = v_uuid;
    END IF;

    -- One action name per resolution, the way staff_reply_close is its own
    -- name: "how many reports did this moderator dismiss" is then one index
    -- scan on (actor_account_id, action, created_at) rather than a text match.
    INSERT INTO public.staff_action (actor_account_id, action, target)
    VALUES (v_actor_id, 'staff_report_' || p_resolution, 'report:' || p_id);

    RETURN 'ok';
END; $$;

-- 'ok' | 'forbidden' | 'bad_credentials' | 'rate_limited' | 'not_found' | 'invalid'.
--
-- The reversal, both halves of it: `account.banned_until` or `muted_until` is
-- the state that stops a login or a shout, and `punishment` is the record
-- /bans reads. Clearing only the first - which is what unbanning by hand in
-- psql does - leaves the public page saying somebody is serving a ban they are
-- not, forever, because nothing ever revisits that row. The row is never
-- deleted: "lifted" is what changes, and that is the point of a permanent
-- record. `tools/server/account.ts lift` is the same two writes from a shell.
--
-- One punishment, not one account: the id says which. A mute lifted on an
-- account that is also banned clears `muted_until` and leaves the ban standing,
-- because two decisions were taken and only one of them is being undone.
--
-- 'not_found' covers three things the page words as one ("that punishment is
-- gone, or has already been lifted"): no such row, a row already lifted, and a
-- row that ran its course on its own. Stamping the last would credit a
-- moderator with the passage of time.
CREATE OR REPLACE FUNCTION accounts.staff_lift(p_actor text, p_candidate_hash text,
                                               p_punishment_id int, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor_id int; v_password text; v_account_id int; v_username text; v_kind text; v_note text;
BEGIN
    IF NOT accounts.is_staff(p_actor) THEN RETURN 'forbidden'; END IF;
    IF accounts.throttled('lift:' || p_actor, p_actor) THEN RETURN 'rate_limited'; END IF;

    SELECT a.id, a.password INTO v_actor_id, v_password FROM public.account a WHERE a.username = p_actor;

    IF p_candidate_hash IS NULL OR length(p_candidate_hash) <> 60
       OR v_password IS NULL OR v_password <> p_candidate_hash THEN
        PERFORM accounts.record_failure('lift:' || p_actor, p_actor);
        RETURN 'bad_credentials';
    END IF;

    -- The note goes on a page anybody can read, so it is one line by design.
    v_note := nullif(btrim(coalesce(p_note, '')), '');
    IF v_note IS NOT NULL AND length(v_note) > 120 THEN RETURN 'invalid'; END IF;

    SELECT p.account_id, p.username, p.kind INTO v_account_id, v_username, v_kind
      FROM public.punishment p
     WHERE p.id = p_punishment_id
       AND p.lifted_at IS NULL
       AND (p.until IS NULL OR p.until > now());
    IF v_account_id IS NULL THEN RETURN 'not_found'; END IF;

    UPDATE public.punishment
       SET lifted_at = now(),
           lifted_by_account_id = v_actor_id,
           note = coalesce(v_note, note)
     WHERE id = p_punishment_id;

    IF v_kind = 'ban' THEN
        UPDATE public.account SET banned_until = NULL WHERE id = v_account_id;
    ELSIF v_kind = 'mute' THEN
        UPDATE public.account SET muted_until = NULL WHERE id = v_account_id;
    END IF;

    -- Named for the door it came in by, beside staff_lift_cli from the shell.
    INSERT INTO public.staff_action (actor_account_id, action, target)
    VALUES (v_actor_id, 'staff_lift', v_username);

    RETURN 'ok';
END; $$;

-- 'ok' | 'forbidden' | 'not_found' | 'invalid'.
--
-- 'ok' | 'forbidden' | 'rate_limited' | 'not_found' | 'invalid'.
--
-- The one-line public explanation on a punishment. No password: it writes a
-- sentence onto a row that is already public and changes nobody's access to
-- anything, which is the test every other verb here fails.
--
-- It gets staff_notice's hourly cap instead, and for the same reason: no
-- password means no bad_credentials, so nothing else in this function slows
-- anybody down, and it writes text onto pages the public reads. Twenty an hour
-- per moderator, counted off the audit rows this function's own writes leave -
-- so the limiter and the record of what was limited are the same table, and a
-- moderator who hits it has twenty notes on /bans to look at.
--
-- An empty note clears one. A public note that turns out to name the wrong
-- person has to be removable by the person who wrote it, and the alternative -
-- refusing the empty string like staff_notice does - would make psql the only
-- way to take a sentence off a public page. A clear costs an hour's allowance
-- like anything else: it is still a public page changing.
CREATE OR REPLACE FUNCTION accounts.staff_punishment_note(p_actor text, p_id int, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor_id int; v_username text; v_note text; v_hour int;
BEGIN
    IF NOT accounts.is_staff(p_actor) THEN RETURN 'forbidden'; END IF;

    IF p_note IS NULL THEN RETURN 'invalid'; END IF;

    v_note := nullif(btrim(p_note), '');
    IF v_note IS NOT NULL AND length(v_note) > 120 THEN RETURN 'invalid'; END IF;

    SELECT a.id INTO v_actor_id FROM public.account a WHERE a.username = p_actor;

    -- The index behind this is 3_message_centre's
    -- staff_action_actor_account_id_action_created_at_idx, which staff_notice's
    -- own cap already scans.
    SELECT count(*) INTO v_hour FROM public.staff_action s
     WHERE s.actor_account_id = v_actor_id AND s.action = 'staff_punishment_note'
       AND s.created_at > now() - interval '1 hour';
    IF v_hour >= 20 THEN RETURN 'rate_limited'; END IF;

    SELECT p.username INTO v_username FROM public.punishment p WHERE p.id = p_id;
    IF v_username IS NULL THEN RETURN 'not_found'; END IF;

    UPDATE public.punishment SET note = v_note WHERE id = p_id;

    INSERT INTO public.staff_action (actor_account_id, action, target)
    VALUES (v_actor_id, 'staff_punishment_note', v_username);

    RETURN 'ok';
END; $$;

-- ---------------------------------------------------------------------------
-- the public record
-- ---------------------------------------------------------------------------
--
-- These four are the transparency half, and they are the only functions in
-- this database granted to a caller that has not signed in as anybody. What
-- they leave out is the design: no `issued_by_account_id`, no
-- `lifted_by_account_id`, no name of any moderator, no `account_id`, no ip, no
-- `staff_spawn.staff_account_id` and no `staff_spawn.target_account_id`. The
-- decision that a punishment is public and its issuer is not lives here, in
-- the select list, where the website could not defeat it if it tried.

-- The permanent record, newest first. `until` null is permanent; `note` is the
-- optional one line; `lifted_at` set means a moderator reversed it and the row
-- stays anyway.
--
-- The page asks for one row more than it shows to learn whether there is a
-- next page, so the limit is honoured up to 100 rather than pinned to a page
-- size this function does not know.
--
-- The offset is capped too, at 100 000. An OFFSET is not free - postgres walks
-- and discards every row it skips - so `/bans/page/500000` from an unsigned-in
-- reader is a full index scan of a table that only ever grows, once per
-- request, and ISR caches each distinct page number separately. Five thousand
-- pages is more of the record than anybody will ever page through by hand;
-- past that the answer is empty, which is what a page number past the end
-- should say anyway.
CREATE OR REPLACE FUNCTION accounts.public_punishments(p_limit int, p_offset int)
RETURNS TABLE (username text, kind text, issued_at timestamptz, until timestamptz,
               automated boolean, note text, lifted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p.username, p.kind, p.issued_at, p.until, p.automated, p.note, p.lifted_at
    FROM public.punishment p
    ORDER BY p.issued_at DESC, p.id DESC
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
    OFFSET least(greatest(coalesce(p_offset, 0), 0), 100000);
$$;

-- The census, hourly, for the window the page asks for.
--
-- One profile, and the caller does not get to say which: accounts.public_profile()
-- above is a constant in a function granted to nobody. Newest first with a
-- ceiling, because the page sorts these into a series
-- itself and a truncated answer should be missing the oldest hours, not the
-- ones the totals are read from.
CREATE OR REPLACE FUNCTION accounts.public_economy(p_days int)
RETURNS TABLE (taken_at timestamptz, players int, coins bigint, tracked jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT es.taken_at, es.players, es.coins, es.tracked
    FROM public.economy_snapshot es
    WHERE es.profile = accounts.public_profile()
      AND es.taken_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
    ORDER BY es.taken_at DESC, es.id DESC
    LIMIT 2400;
$$;

-- What entered or left the game, per tracked item, per census. Positive
-- entered, negative left, and a zero is never written. No account is named on
-- either side of it: the row says a robin hood hat exists that did not exist an
-- hour ago, not who is wearing it.
CREATE OR REPLACE FUNCTION accounts.public_economy_flow(p_days int)
RETURNS TABLE (taken_at timestamptz, item_id int, delta int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT ef.taken_at, ef.item_id, ef.delta
    FROM public.economy_flow ef
    WHERE ef.profile = accounts.public_profile()
      AND ef.taken_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
    ORDER BY ef.taken_at DESC, ef.item_id
    LIMIT 5000;
$$;

-- Items staff conjured, newest first, so the census does not have to explain a
-- step in the totals it cannot account for. Which world, what and how many -
-- never who made it and never who got it.
CREATE OR REPLACE FUNCTION accounts.public_staff_spawns(p_days int)
RETURNS TABLE (created_at timestamptz, item_id int, count int, world int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT ss.created_at, ss.item_id, ss.count, ss.world
    FROM public.staff_spawn ss
    WHERE ss.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
    ORDER BY ss.created_at DESC, ss.id DESC
    LIMIT 500;
$$;

-- ---------------------------------------------------------------------------
-- retention
-- ---------------------------------------------------------------------------

-- 2_website_login's reaper, same signature, plus the two retention rules
-- migration 4 introduces. Still hourly under pg_cron, and still the only thing
-- that deletes anything on a schedule except the friend server.
--
-- **Chat is not here.** `public_chat` and `private_chat` are swept by their own
-- writer, the friend server, an hour after they were said - that sweep has to
-- work on sqlite and mysql too, and a rule in two places is a rule that ends up
-- disagreeing with itself. What is here is the evidence copy of that chat,
-- which is a different table with a different life.
--
-- Evidence dies when every report behind its uuid is either older than thirty
-- days or dismissed - one uuid can cover several reports of the same macroer,
-- and the capture belongs to all of them. Evidence with no report row at all is
-- kept for thirty days by its own clock: the logger server and the login server
-- write into the same uuid from two processes with no ordering between them, so
-- a chunk that arrives a second before the report row must not be reaped in
-- between.
CREATE OR REPLACE FUNCTION accounts.reap() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_signups bigint; v_logins bigint; v_wealth bigint; v_input bigint; v_chat bigint;
BEGIN
    DELETE FROM public.signup_attempt WHERE created_at < now() - interval '24 hours';
    GET DIAGNOSTICS v_signups = ROW_COUNT;

    DELETE FROM public.login_attempt WHERE created_at < now() - interval '1 hour';
    GET DIAGNOSTICS v_logins = ROW_COUNT;

    -- Wealth events are adjudication material for a live report, not history.
    DELETE FROM public.session_wealth WHERE timestamp < now() - interval '7 days';
    GET DIAGNOSTICS v_wealth = ROW_COUNT;

    DELETE FROM public.report_input ri
     WHERE CASE WHEN EXISTS (SELECT 1 FROM public.report r WHERE r.uuid = ri.report_uuid)
                THEN NOT EXISTS (SELECT 1 FROM public.report r
                                  WHERE r.uuid = ri.report_uuid
                                    AND r.timestamp > now() - interval '30 days'
                                    AND r.resolution IS DISTINCT FROM 'dismissed')
                ELSE ri.flushed_at < now() - interval '30 days'
           END;
    GET DIAGNOSTICS v_input = ROW_COUNT;

    DELETE FROM public.report_chat rc
     WHERE CASE WHEN EXISTS (SELECT 1 FROM public.report r WHERE r.uuid = rc.report_uuid)
                THEN NOT EXISTS (SELECT 1 FROM public.report r
                                  WHERE r.uuid = rc.report_uuid
                                    AND r.timestamp > now() - interval '30 days'
                                    AND r.resolution IS DISTINCT FROM 'dismissed')
                ELSE rc.at < now() - interval '30 days'
           END;
    GET DIAGNOSTICS v_chat = ROW_COUNT;

    RETURN v_signups + v_logins + v_wealth + v_input + v_chat;
END; $$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER functions are EXECUTE-able by PUBLIC by default, so the
-- default comes off every one of them before anything is granted.
-- accounts.report_offender and accounts.public_profile are granted to nobody,
-- like is_staff, throttled and record_failure: they are helpers the functions
-- above call while running as the definer, not an API.
--
-- staff_reports and reap are re-granted because they were replaced. reap keeps
-- its grant across a CREATE OR REPLACE and staff_reports could not be replaced
-- at all - it was dropped and rebuilt for its three new columns, taking its
-- grant with it - so both are written out rather than reasoned about.

REVOKE ALL ON FUNCTION accounts.report_offender(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.public_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_reports(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_report(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_report_input(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_report_chat(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_report_wealth(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_wealth(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_report_resolve(text, text, int, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_lift(text, text, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.staff_punishment_note(text, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.public_punishments(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.public_economy(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.public_economy_flow(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.public_staff_spawns(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.reap() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounts.staff_reports(text, timestamptz) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_report(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_report_input(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_report_chat(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_report_wealth(text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_wealth(text, text, timestamptz) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_report_resolve(text, text, int, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_lift(text, text, int, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.staff_punishment_note(text, int, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.public_punishments(int, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.public_economy(int) TO website;
GRANT EXECUTE ON FUNCTION accounts.public_economy_flow(int) TO website;
GRANT EXECUTE ON FUNCTION accounts.public_staff_spawns(int) TO website;
GRANT EXECUTE ON FUNCTION accounts.reap() TO website;

-- Fourteen GRANT statements above: twelve functions this migration adds, plus
-- staff_reports and reap, which it replaces and which were already granted by
-- 2_website_login and 3_message_centre. That takes the website role to
-- **thirty-two** executable functions in accounts, and to exactly as many table
-- privileges as it had on the day 0_init created it: none. `select * from
-- punishment` as website is refused, and so is `select * from report_input`,
-- `report_chat`, `staff_spawn`, `economy_snapshot` and `economy_flow`.
--
-- Ungranted on purpose, still: is_staff, throttled, record_failure, and now
-- report_offender and public_profile. Six functions in accounts that no role
-- may call directly, and thirty-two that website may.
--
-- Two things a reader of the next migration should know, neither of them fixed
-- here:
--
--   The password buckets share a ceiling. accounts.throttled(bucket, actor) was
--   written in 3_message_centre with the *actor's bare name* in the ip slot,
--   because there is no address to pass - the route calls these with the
--   session's username only. So `notice:bob`, `resolve:bob` and `lift:bob` each
--   get their own ten-per-fifteen-minutes username limb, but all three record
--   failures with ip = 'bob' and therefore share one twenty-per-fifteen-minutes
--   ip limb. Twenty wrong passwords spread across the three verbs locks bob out
--   of all three. That is inherited and it is not obviously wrong - it is still
--   bob's own bucket and it still cannot touch his login - but it is not what
--   the per-verb prefixes look like they promise, and anybody adding a fourth
--   verb should know they are joining a shared ceiling rather than opening a
--   new one.
--
--   public.session has no index leading with account_id. The only one is
--   2_website_login's (profile, account_id, timestamp DESC), and staff_report's
--   offender-session fallback and staff_report_wealth both look a player up
--   without a profile to pass - `report` does not carry one. One report at a
--   time on a staff page, so it is cheap today and a sequential scan of
--   `session` when that table is large. Either an (account_id, timestamp DESC)
--   index or a profile column on `report` fixes it; both are a later
--   migration's job, and the second would fix a correctness wrinkle too (an
--   account with a character on two profiles can have a wealth event from the
--   wrong one quoted inside the window).

-- ---------------------------------------------------------------------------
-- rollback
-- ---------------------------------------------------------------------------
--
-- Commented, because a rollback is a decision somebody makes at a prompt with
-- the row counts in front of them, not something a migration runner can take
-- back. Run it top to bottom as the owner; it undoes this file and nothing
-- else, and it deletes every punishment, spawn, census and piece of evidence
-- recorded since it was applied. Take a backup first.
--
-- rollback:
--
-- DROP FUNCTION IF EXISTS accounts.public_staff_spawns(int);
-- DROP FUNCTION IF EXISTS accounts.public_economy_flow(int);
-- DROP FUNCTION IF EXISTS accounts.public_economy(int);
-- DROP FUNCTION IF EXISTS accounts.public_punishments(int, int);
-- DROP FUNCTION IF EXISTS accounts.staff_punishment_note(text, int, text);
-- DROP FUNCTION IF EXISTS accounts.staff_lift(text, text, int, text);
-- DROP FUNCTION IF EXISTS accounts.staff_report_resolve(text, text, int, text, text);
-- DROP FUNCTION IF EXISTS accounts.staff_wealth(text, text, timestamptz);
-- DROP FUNCTION IF EXISTS accounts.staff_report_wealth(text, int);
-- DROP FUNCTION IF EXISTS accounts.staff_report_chat(text, int);
-- DROP FUNCTION IF EXISTS accounts.staff_report_input(text, int);
-- DROP FUNCTION IF EXISTS accounts.staff_report(text, int);
-- DROP FUNCTION IF EXISTS accounts.report_offender(int);
-- DROP FUNCTION IF EXISTS accounts.public_profile();
--
-- -- 3_message_centre's staff_reports, restored. Dropped first for the same
-- -- reason it was dropped above: the return type is changing back.
-- DROP FUNCTION IF EXISTS accounts.staff_reports(text, timestamptz);
-- CREATE OR REPLACE FUNCTION accounts.staff_reports(p_actor text, p_since timestamptz)
-- RETURNS TABLE (id int, reported_at timestamptz, world int, reporter text,
--                offender text, reason int, coord int, session_uuid text)
-- LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $ROLLBACK$
--     SELECT r.id, r.timestamp, r.world, coalesce(reporter.username, ''),
--            r.offender, r.reason, r.coord, r.session_uuid
--     FROM public.report r
--     LEFT JOIN public.account reporter ON reporter.id = r.reporter_account_id
--     WHERE accounts.is_staff(p_actor)
--       AND r.timestamp > coalesce(p_since, now() - interval '7 days')
--     ORDER BY r.timestamp DESC
--     LIMIT 500;
-- $ROLLBACK$;
-- REVOKE ALL ON FUNCTION accounts.staff_reports(text, timestamptz) FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION accounts.staff_reports(text, timestamptz) TO website;
--
-- -- 2_website_login's reaper, restored.
-- CREATE OR REPLACE FUNCTION accounts.reap() RETURNS bigint
-- LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $ROLLBACK$
-- DECLARE v_signups bigint; v_logins bigint;
-- BEGIN
--     DELETE FROM public.signup_attempt WHERE created_at < now() - interval '24 hours';
--     GET DIAGNOSTICS v_signups = ROW_COUNT;
--     DELETE FROM public.login_attempt WHERE created_at < now() - interval '1 hour';
--     GET DIAGNOSTICS v_logins = ROW_COUNT;
--     RETURN v_signups + v_logins;
-- END; $ROLLBACK$;
-- REVOKE ALL ON FUNCTION accounts.reap() FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION accounts.reap() TO website;
--
-- DROP INDEX IF EXISTS public.economy_flow_profile_taken_at_idx;
-- DROP INDEX IF EXISTS public.economy_snapshot_profile_taken_at_idx;
-- DROP INDEX IF EXISTS public.staff_spawn_created_at_idx;
-- DROP INDEX IF EXISTS public.punishment_account_id_idx;
-- DROP INDEX IF EXISTS public.punishment_issued_at_idx;
-- DROP INDEX IF EXISTS public.private_chat_account_id_timestamp_idx;
-- DROP INDEX IF EXISTS public.private_chat_timestamp_idx;
-- DROP INDEX IF EXISTS public.public_chat_session_uuid_timestamp_idx;
-- DROP INDEX IF EXISTS public.public_chat_timestamp_idx;
-- DROP INDEX IF EXISTS public.session_wealth_session_uuid_timestamp_idx;
-- DROP INDEX IF EXISTS public.session_wealth_timestamp_idx;
-- DROP INDEX IF EXISTS public.report_chat_report_uuid_at_idx;
-- DROP INDEX IF EXISTS public.report_input_report_uuid_seq_idx;
-- DROP INDEX IF EXISTS public.report_offender_account_id_timestamp_idx;
-- DROP INDEX IF EXISTS public.report_uuid_idx;
--
-- DROP TABLE IF EXISTS public.economy_flow;
-- DROP TABLE IF EXISTS public.economy_snapshot;
-- DROP TABLE IF EXISTS public.staff_spawn;
-- DROP TABLE IF EXISTS public.punishment;
-- DROP TABLE IF EXISTS public.report_chat;
-- DROP TABLE IF EXISTS public.report_input;
--
-- ALTER TABLE public.report DROP COLUMN IF EXISTS staff_note;
-- ALTER TABLE public.report DROP COLUMN IF EXISTS resolved_by_account_id;
-- ALTER TABLE public.report DROP COLUMN IF EXISTS resolution;
-- ALTER TABLE public.report DROP COLUMN IF EXISTS resolved_at;
-- ALTER TABLE public.report DROP COLUMN IF EXISTS offender_coord;
-- ALTER TABLE public.report DROP COLUMN IF EXISTS offender_session_uuid;
-- ALTER TABLE public.report DROP COLUMN IF EXISTS offender_account_id;
-- ALTER TABLE public.report DROP COLUMN IF EXISTS uuid;
