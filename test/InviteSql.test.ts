import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 6's functions, read back from the file. Nothing in this repo runs
// them; the Docker rehearsal in ec2-setup does, once, before production. What
// must not drift silently - who may execute what, which rows are never
// deleted, that the welcome notice and migration 4's retention rules survive -
// is pinned here.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/6_invites/migration.sql');
const migration3 = read('../prisma/postgres/migrations/3_message_centre/migration.sql');
const migration4 = read('../prisma/postgres/migrations/4_evidence_and_records/migration.sql');

const ROLLBACK = '\n-- rollback:';
assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');

const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

function functions(sql: string): Map<string, { header: string; body: string }> {
    const found = new Map<string, { header: string; body: string }>();

    for (const match of sql.matchAll(/CREATE OR REPLACE FUNCTION accounts\.(\w+)\(/g)) {
        const start = match.index;
        const open = sql.indexOf('$$', start);
        const close = sql.indexOf('$$;', open + 2);

        assert.notEqual(open, -1, `${match[1]}: no body`);
        assert.notEqual(close, -1, `${match[1]}: no end of body`);

        found.set(match[1], { header: sql.slice(start, open), body: sql.slice(open + 2, close) });
    }

    return found;
}

const defined = functions(live);

/** Granted to website, with the argument list each is REVOKEd and GRANTed by. */
const API: [string, string][] = [
    ['invite_preview', 'text, text'],
    ['register_with_invite', 'text, text, text, text, text, text, text, text'],
    ['invite_create', 'text, text'],
    ['invite_revoke', 'text, text'],
    ['invites', 'text'],
    ['citizen', 'text'],
    ['staff_set_invites', 'text, text, text, boolean'],
    ['staff_invite_tree', 'text, text'],
    ['staff_inviters', 'text'],
    ['reap', '']
];

/** Defined, REVOKEd from PUBLIC, granted to nobody. */
const HELPERS: [string, string][] = [
    ['invite_maker_ok', 'int'],
    ['invite_state', 'timestamptz, timestamptz, timestamptz, boolean'],
    ['revoke_invites_on_ban', '']
];

test('migration 6 defines exactly the API and its helpers', () => {
    assert.deepEqual([...defined.keys()].sort(), [...API, ...HELPERS].map(([name]) => name).sort());
});

test('every function is SECURITY DEFINER with the search_path pinned', () => {
    for (const [name, { header }] of defined) {
        assert.ok(header.includes('SECURITY DEFINER'), `${name}: SECURITY DEFINER`);
        assert.ok(header.includes('SET search_path = public, pg_temp'), `${name}: search_path`);
    }
});

test('the API is revoked from PUBLIC before it is granted, and the helpers are granted to nobody', () => {
    for (const [name, args] of [...API, ...HELPERS]) {
        const revoke = `REVOKE ALL ON FUNCTION accounts.${name}(${args}) FROM PUBLIC;`;
        assert.ok(live.includes(revoke), `REVOKE ${name}`);
    }

    for (const [name, args] of API) {
        const revoke = `REVOKE ALL ON FUNCTION accounts.${name}(${args}) FROM PUBLIC;`;
        const grant = `GRANT EXECUTE ON FUNCTION accounts.${name}(${args}) TO website;`;
        assert.ok(live.indexOf(revoke) < live.indexOf(grant), `${name}: revoked before granted`);
    }

    const granted = [...live.matchAll(/^GRANT EXECUTE ON FUNCTION accounts\.(\w+)\(([^)]*)\) TO website;$/gm)].map(match => [match[1], match[2]] as [string, string]);
    assert.deepEqual(granted, API);
});

test('the website can no longer create an account without an invite', () => {
    assert.ok(live.includes('REVOKE EXECUTE ON FUNCTION accounts.register(text, text, text, text, text, text, text) FROM website;'), 'register revoked');
    assert.ok(rollback.includes('-- GRANT EXECUTE ON FUNCTION accounts.register(text, text, text, text, text, text, text) TO website;'), 'and the rollback gives it back');
});

test('the migration grants nothing on a table', () => {
    for (const grant of migration.match(/^GRANT .*/gm) ?? []) {
        assert.ok(grant.includes('ON FUNCTION'), grant);
    }
});

test('plpgsql functions returning a table resolve name clashes to the column', () => {
    for (const name of ['invite_preview', 'register_with_invite', 'invite_create']) {
        assert.ok(defined.get(name)!.body.trimStart().startsWith('#variable_conflict use_column'), name);
    }
});

test('a claim is serialised per code and per name, and the pooler-safe way', () => {
    const { body } = defined.get('register_with_invite')!;
    assert.ok(body.includes("pg_advisory_xact_lock(hashtext('invite:' || coalesce(p_code, '')))"), 'code lock');
    assert.ok(body.includes("pg_advisory_xact_lock(hashtext('username:' || coalesce(p_username, '')))"), 'name lock');
    assert.ok(body.includes('FOR UPDATE'), 'the invite row is locked before it is judged');
    assert.ok(!/pg_advisory_lock\(/.test(live), 'no session-scoped advisory lock anywhere');

    // cancelling takes the same code lock, so a cancel and a claim cannot interleave
    assert.ok(defined.get('invite_revoke')!.body.includes("pg_advisory_xact_lock(hashtext('invite:' || coalesce(p_code, '')))"), 'revoke uses the same lock');
});

test('the caps are charged only for an account that was created', () => {
    const { body } = defined.get('register_with_invite')!;
    const account = body.indexOf('INSERT INTO public.account (');
    const claim = body.indexOf('UPDATE public.invite');
    const charge = body.indexOf('INSERT INTO public.signup_attempt');

    assert.ok(account !== -1 && claim !== -1 && charge !== -1, 'all three writes exist');
    assert.ok(account < claim && claim < charge, 'account, then claim, then charge');
    assert.ok(body.includes('WHEN unique_violation THEN'), 'losing the name race costs nothing');
    assert.ok(body.includes('v_ip_recent >= 3 OR v_ip_day >= 10 OR v_group_day >= 30 OR v_misses >= 30'), 'the same caps as register, plus the guessing cap');
});

test('a new account gets the same welcome notice register gave it', () => {
    const start = "'Welcome to Zanaris.";
    const end = "Have fun out there.'";
    const slice = (sql: string) => sql.slice(sql.indexOf(start), sql.indexOf(end) + end.length);

    assert.ok(slice(migration3).length > 100, 'found the notice in migration 3');
    assert.equal(slice(defined.get('register_with_invite')!.body), slice(migration3));
});

test('nothing in the registration path switches inviting on', () => {
    assert.ok(!/invites_enabled\s*=\s*true/i.test(defined.get('register_with_invite')!.body), 'register_with_invite');
    assert.ok(!defined.get('register_with_invite')!.body.includes('invites_enabled'), 'does not even name the column');
});

test('the live-link and daily caps are twenty and a hundred', () => {
    const { body } = defined.get('invite_create')!;
    assert.ok(body.includes('v_live >= 20 OR v_today >= 100'), 'caps');
    assert.ok(body.includes("now() + interval '14 days'"), 'fourteen-day links');
    assert.ok(body.includes("p_code !~ '^[0-9A-HJKMNP-TV-Z]{16}$'"), 'the same code shape as the CHECK');
});

test('staff verbs check staff first and re-type the password', () => {
    const { body } = defined.get('staff_set_invites')!;
    assert.ok(body.indexOf('accounts.is_staff(p_actor)') < body.indexOf('p_candidate_hash'), 'staff check first');
    assert.ok(body.includes("accounts.throttled('invites:' || p_actor, p_actor)"), 'throttled');
    assert.ok(body.includes("accounts.record_failure('invites:' || p_actor, p_actor)"), 'failures recorded');
    assert.ok(body.includes("'invites_enabled'") && body.includes("'invites_disabled'"), 'both staff_action names');
    assert.ok(body.includes("revoked_reason = 'staff'"), 'switching off revokes live links');

    for (const name of ['staff_invite_tree', 'staff_inviters']) {
        assert.ok(defined.get(name)!.body.includes('accounts.is_staff(p_actor)'), `${name} is staff-only`);
    }
});

test('a ban switches inviting off through a trigger, and only a ban does', () => {
    assert.ok(live.includes('DROP TRIGGER IF EXISTS account_ban_revokes_invites ON public.account;'), 'idempotent');
    assert.ok(live.includes('BEFORE UPDATE OF banned_until ON public.account'), 'fires on banned_until only');
    assert.ok(live.includes('WHEN (NEW.banned_until IS NOT NULL AND NEW.banned_until > now() AND NEW.banned_until IS DISTINCT FROM OLD.banned_until)'), 'only a new ban in force');
    assert.ok(live.indexOf('DROP TRIGGER IF EXISTS account_ban_revokes_invites') < live.indexOf('CREATE TRIGGER account_ban_revokes_invites'), 'dropped before created');

    const { body } = defined.get('revoke_invites_on_ban')!;
    assert.ok(body.includes("revoked_reason = 'banned'"), 'links revoked as banned');
    assert.ok(body.includes('NEW.invites_enabled := false;'), 'flag off, on the row being written');
    assert.ok(body.includes('RETURN NEW;'), 'and the ban itself still lands');
});

test('reap keeps migration 4 word for word and never deletes a claimed link', () => {
    const reap4 = functions(migration4.slice(0, migration4.indexOf(ROLLBACK))).get('reap')!.body;
    const reap6 = defined.get('reap')!.body;

    const rules = reap4.match(/DELETE FROM public\.[\s\S]*?;/g) ?? [];
    assert.equal(rules.length, 5, "migration 4's five rules");
    for (const rule of rules) {
        assert.ok(reap6.includes(rule), `kept: ${rule.split('\n')[0]}`);
    }

    assert.ok(reap6.includes("DELETE FROM public.invite_attempt WHERE created_at < now() - interval '1 hour';"), 'guesses kept an hour');
    assert.ok(reap6.includes("DELETE FROM public.invite\n     WHERE claimed_at IS NULL\n       AND expires_at < now() - interval '90 days';"), 'only unclaimed links, ninety days after they died');
});

test('the rollback undoes everything, and is prose', () => {
    for (const [name, args] of [...API, ...HELPERS]) {
        if (name === 'reap') continue;
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${name}(${args});`), `drops ${name}`);
    }

    assert.ok(rollback.includes('-- DROP TRIGGER IF EXISTS account_ban_revokes_invites ON public.account;'), 'drops the trigger');
    assert.ok(rollback.includes('-- DROP TABLE IF EXISTS "invite_attempt";'), 'drops invite_attempt');
    assert.ok(rollback.includes('-- DROP TABLE IF EXISTS "invite";'), 'drops invite');
    assert.ok(rollback.includes('-- ALTER TABLE "account" DROP COLUMN IF EXISTS "invites_enabled";'), 'drops the column');
    assert.ok(rollback.includes('-- CREATE OR REPLACE FUNCTION accounts.reap() RETURNS bigint'), "restores migration 4's reaper");

    for (const line of rollback.split('\n')) {
        assert.ok(line === '' || line.startsWith('--'), `rollback is prose: ${line}`);
    }
});
