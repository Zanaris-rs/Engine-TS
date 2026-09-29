-- ---------------------------------------------------------------------------
-- accounts.register: charge the caps for accounts created, not for calls made
-- ---------------------------------------------------------------------------
--
-- 0_init wrote a `signup_attempt` row on *every* call, before it knew whether
-- the call would succeed. Two consequences, both bad:
--
--   * a player who picks a name that is already taken burns a slot, and after
--     three unlucky guesses cannot register at all for ten minutes;
--   * a call that is already `rate_limited` still writes a row, so hammering
--     the endpoint pushes the window out in front of itself and the ip stays
--     locked out for as long as the hammering continues - including for the
--     real player sharing that CGNAT address.
--
-- So the row moves to the end: it is written only once the caps have been
-- checked, the name has been found free, and the account row has actually gone
-- in. `signup_attempt` therefore counts *accounts created* from an ip, which is
-- the thing the caps are meant to limit. Everything that fails - a taken name,
-- a lost race to the unique index, a rate-limited call - costs nothing.
--
-- The abuse this gives up on is cheap failed calls, which cost postgres one
-- indexed count each and are handled at the edge (Turnstile in front of the
-- route, and Vercel's own limits) rather than here.
--
-- Caps, raised now that they are only charged for successes:
--   3 per ip per 10 minutes    - one person, one sitting
--   10 per ip per day          - a household or a small shared connection
--   30 per ip_group per day    - a /24 (or /64), i.e. an ISP pool or a campus
--
-- Everything else about the function is unchanged and deliberate: SECURITY
-- DEFINER (the website role has no privileges on public.account at all), the
-- pinned search_path, the seven positional parameters, and the three return
-- values 'ok' / 'username_taken' / 'rate_limited', which the website compares
-- against by hand.
CREATE OR REPLACE FUNCTION accounts.register(
    p_username text,
    p_email text,
    p_email_normalized text,
    p_password_hash text,
    p_ip text,
    p_ip_group text,
    p_agent_hash text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_soak_minutes int := coalesce(nullif(current_setting('app.soak_minutes', true), '')::int, 0);
    v_ip_recent int;
    v_ip_day int;
    v_group_day int;
BEGIN
    SELECT count(*) INTO v_ip_recent
    FROM public.signup_attempt
    WHERE ip = p_ip AND created_at > now() - interval '10 minutes';

    SELECT count(*) INTO v_ip_day
    FROM public.signup_attempt
    WHERE ip = p_ip AND created_at > now() - interval '1 day';

    SELECT count(*) INTO v_group_day
    FROM public.signup_attempt
    WHERE ip_group = p_ip_group AND created_at > now() - interval '1 day';

    IF v_ip_recent >= 3 OR v_ip_day >= 10 OR v_group_day >= 30 THEN
        RETURN 'rate_limited';
    END IF;

    IF EXISTS (SELECT 1 FROM public.account WHERE username = p_username) THEN
        RETURN 'username_taken';
    END IF;

    -- A nested block, so losing the race to the unique index between the check
    -- above and this insert rolls back only the insert. Nothing has been
    -- charged yet at this point, so that loser walks away owing nothing.
    BEGIN
        INSERT INTO public.account (
            username,
            password,
            email,
            email_normalized,
            registration_ip,
            registration_group,
            registration_date,
            signup_agent_hash,
            playable_after,
            staffmodlevel
        ) VALUES (
            p_username,
            p_password_hash,
            p_email,
            p_email_normalized,
            p_ip,
            p_ip_group,
            now(),
            p_agent_hash,
            CASE WHEN v_soak_minutes > 0 THEN now() + make_interval(mins => v_soak_minutes) ELSE NULL END,
            0
        );
    EXCEPTION
        WHEN unique_violation THEN
            RETURN 'username_taken';
    END;

    -- The account exists; charge the caps. Same transaction as the insert
    -- above, so the two rows can never disagree about what happened.
    INSERT INTO public.signup_attempt (ip, ip_group) VALUES (p_ip, p_ip_group);

    RETURN 'ok';
END;
$$;

-- CREATE OR REPLACE keeps the existing ACL, but say it again so applying this
-- file to a database that somehow lost the grants still lands somewhere safe.
REVOKE ALL ON FUNCTION accounts.register(text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounts.register(text, text, text, text, text, text, text) TO website;
