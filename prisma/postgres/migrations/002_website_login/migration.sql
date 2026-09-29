-- 2_website_login: website login, the account centre, and their rate limits.
-- website still gets no table privilege. Everything is SECURITY DEFINER,
-- REVOKEd from PUBLIC, keyed by the username from the signed session cookie,
-- except login itself.

CREATE TABLE IF NOT EXISTS "login_attempt" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "login_attempt_username_created_at_idx" ON "login_attempt"("username", "created_at");
CREATE INDEX IF NOT EXISTS "login_attempt_ip_created_at_idx" ON "login_attempt"("ip", "created_at");
ALTER TABLE "login_attempt" ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS "session_profile_account_id_timestamp_idx" ON "session"("profile", "account_id", "timestamp" DESC);

-- internal helpers: NOT granted to website
CREATE OR REPLACE FUNCTION accounts.throttled(p_username text, p_ip text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user int; v_ip int;
BEGIN
    SELECT count(*) INTO v_user FROM public.login_attempt
     WHERE username = p_username AND created_at > now() - interval '15 minutes';
    SELECT count(*) INTO v_ip FROM public.login_attempt
     WHERE ip = p_ip AND created_at > now() - interval '15 minutes';
    RETURN v_user >= 10 OR v_ip >= 20;
END; $$;

CREATE OR REPLACE FUNCTION accounts.record_failure(p_username text, p_ip text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    INSERT INTO public.login_attempt (username, ip) VALUES (p_username, p_ip);
$$;

CREATE OR REPLACE FUNCTION accounts.password_salt(p_username text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT substring(a.password from 1 for 29) FROM public.account a WHERE a.username = p_username;
$$;

-- 'ok' | 'bad_credentials' | 'rate_limited'. A ban does NOT refuse login.
CREATE OR REPLACE FUNCTION accounts.login(p_username text, p_candidate_hash text, p_ip text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_password text;
BEGIN
    IF accounts.throttled(p_username, p_ip) THEN RETURN 'rate_limited'; END IF;
    SELECT a.password INTO v_password FROM public.account a WHERE a.username = p_username;
    IF v_password IS NULL OR p_candidate_hash IS NULL
       OR length(p_candidate_hash) <> 60 OR v_password <> p_candidate_hash THEN
        PERFORM accounts.record_failure(p_username, p_ip);
        RETURN 'bad_credentials';
    END IF;
    RETURN 'ok';
END; $$;

CREATE OR REPLACE FUNCTION accounts.change_password(p_username text, p_current_candidate_hash text, p_new_hash text, p_ip text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_new_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
        RAISE EXCEPTION 'change_password: p_new_hash is not a bcrypt hash';
    END IF;
    IF accounts.throttled(p_username, p_ip) THEN RETURN 'rate_limited'; END IF;
    UPDATE public.account SET password = p_new_hash
     WHERE username = p_username AND password = p_current_candidate_hash;
    IF NOT FOUND THEN PERFORM accounts.record_failure(p_username, p_ip); RETURN 'bad_credentials'; END IF;
    RETURN 'ok';
END; $$;

CREATE OR REPLACE FUNCTION accounts.change_email(p_username text, p_current_candidate_hash text, p_email text, p_email_normalized text, p_ip text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF accounts.throttled(p_username, p_ip) THEN RETURN 'rate_limited'; END IF;
    UPDATE public.account SET email = p_email, email_normalized = p_email_normalized
     WHERE username = p_username AND password = p_current_candidate_hash;
    IF NOT FOUND THEN PERFORM accounts.record_failure(p_username, p_ip); RETURN 'bad_credentials'; END IF;
    RETURN 'ok';
END; $$;

CREATE OR REPLACE FUNCTION accounts.profile(p_username text, p_profile text)
RETURNS TABLE (username text, email text, members boolean, staffmodlevel int,
               registration_date timestamptz, muted_until timestamptz, banned_until timestamptz,
               playable_after timestamptz, salt text,
               logged_in int, login_time timestamptz, logged_out int, logout_time timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.username, a.email, a.members, a.staffmodlevel, a.registration_date,
           a.muted_until, a.banned_until, a.playable_after,
           substring(a.password from 1 for 29),
           l.logged_in, l.login_time, l.logged_out, l.logout_time
    FROM public.account a
    LEFT JOIN public.account_login l ON l.account_id = a.id AND l.profile = p_profile
    WHERE a.username = p_username;
$$;

CREATE OR REPLACE FUNCTION accounts.recent_logins(p_username text, p_profile text, p_limit int)
RETURNS TABLE (world int, logged_in_at timestamptz, ip text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT s.world, s.timestamp, s.ip
    FROM public.session s JOIN public.account a ON a.id = s.account_id
    WHERE a.username = p_username AND s.profile = p_profile
    ORDER BY s.timestamp DESC
    LIMIT least(greatest(coalesce(p_limit, 10), 1), 20);
$$;

CREATE OR REPLACE FUNCTION accounts.reap() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_signups bigint; v_logins bigint;
BEGIN
    DELETE FROM public.signup_attempt WHERE created_at < now() - interval '24 hours';
    GET DIAGNOSTICS v_signups = ROW_COUNT;
    DELETE FROM public.login_attempt WHERE created_at < now() - interval '1 hour';
    GET DIAGNOSTICS v_logins = ROW_COUNT;
    RETURN v_signups + v_logins;
END; $$;

REVOKE ALL ON FUNCTION accounts.throttled(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.record_failure(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.password_salt(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.login(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.change_password(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.change_email(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.profile(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.recent_logins(text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.reap() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounts.password_salt(text) TO website;
GRANT EXECUTE ON FUNCTION accounts.login(text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.change_password(text, text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.change_email(text, text, text, text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.profile(text, text) TO website;
GRANT EXECUTE ON FUNCTION accounts.recent_logins(text, text, int) TO website;
GRANT EXECUTE ON FUNCTION accounts.reap() TO website;
-- deliberately absent: throttled, record_failure, and any grant on login_attempt or session
