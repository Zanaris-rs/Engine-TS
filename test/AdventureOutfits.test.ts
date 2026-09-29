import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 12, read back from the file, and its table in all six places. As
// with the other *Sql tests nothing in this repo executes the functions: the
// website calls them by name and a person applies the file at a psql prompt
// (its behaviour is rehearsed against a real postgres outside this repo). What
// must not drift silently is pinned here.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function modelBody(schema: string, model: string): string {
    const start = schema.indexOf(`\nmodel ${model} {`);
    assert.notEqual(start, -1, `model ${model}`);
    const body = schema.slice(start);
    return body.slice(0, body.indexOf('\n}'));
}

const migration = read('../prisma/postgres/migrations/012_adventure_outfits/migration.sql');
const mysqlMigration = read('../prisma/multiworld/migrations/20260924000001_adventure_outfits/migration.sql');
const sqliteBaseline = read('../prisma/singleworld/migrations/20251229170623_clean/migration.sql');
const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

const ROLLBACK = '\n-- rollback:';
const MARKER = '-- === functions ===';
const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

const COLUMNS = ['account_id', 'slot', 'name', 'gender', 'kits', 'colours', 'worn', 'is_default', 'updated_at'];

const GRANTED = ['outfits(text)', 'outfit_save(text, int, text, int, int[], int[], int[])', 'outfit_delete(text, int)', 'outfit_set_default(text, int)', 'outfit_import_look(text)', 'outfit_default_looks(text[])'];
const HELPERS = ['outfit_ints_ok(int[], int, int, int)', 'outfit_look_ok(int, int[], int[], int[])', 'outfit_owner(text)'];

test('the table is in every backend and every schema, with every column', () => {
    assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS "adventure_outfit" ('), 'postgres');
    assert.ok(mysqlMigration.includes('CREATE TABLE `adventure_outfit` ('), 'mysql');
    assert.ok(sqliteBaseline.includes('CREATE TABLE "adventure_outfit" ('), 'sqlite');

    for (const column of COLUMNS) {
        assert.ok(migration.includes(`"${column}"`), `postgres ${column}`);
        assert.ok(mysqlMigration.includes(`\`${column}\``), `mysql ${column}`);
        assert.ok(sqliteBaseline.includes(`"${column}"`), `sqlite ${column}`);
    }

    assert.ok(mysqlMigration.includes('PRIMARY KEY (`account_id`, `slot`)'), 'mysql key');
    assert.ok(sqliteBaseline.includes('PRIMARY KEY ("account_id", "slot")'), 'sqlite key');

    for (const [name, schema] of Object.entries(schemas)) {
        const model = modelBody(schema, 'adventure_outfit');
        for (const column of COLUMNS) {
            assert.ok(new RegExp(`^\\s+${column}\\s`, 'm').test(model), `${name}: ${column}`);
        }
        assert.ok(model.includes('@@id([account_id, slot])'), `${name}: key`);
    }

    assert.ok(read('../src/db/types.ts').includes('adventure_outfit: adventure_outfit;'), 'generated types');
});

test('postgres checks the slot, the name and the gender, and allows one default', () => {
    assert.ok(migration.includes('CHECK ("slot" BETWEEN 0 AND 9)'), 'ten slots');
    assert.ok(migration.includes('CHECK (length("name") BETWEEN 1 AND 32)'), 'name length, as the site');
    assert.ok(migration.includes('CHECK ("gender" IN (0, 1))'), 'gender');
    assert.ok(migration.includes('CREATE UNIQUE INDEX IF NOT EXISTS "adventure_outfit_one_default_key" ON "adventure_outfit"("account_id") WHERE "is_default";'), 'one default');
    assert.ok(migration.includes('ALTER TABLE "adventure_outfit" ENABLE ROW LEVEL SECURITY;'), 'RLS');
    assert.ok(!migration.includes('CREATE POLICY'), 'no policy');
    assert.ok(!/\bREFERENCES\b/.test(migration), 'no foreign keys');
    assert.ok(!migration.slice(0, migration.indexOf(MARKER)).includes('CREATE OR REPLACE FUNCTION'), 'no functions above the marker');
});

test('the colour ranges are the design palettes, 12 16 16 6 8', () => {
    // Player.DESIGN_BODY_COLORS; the site's validate.ts reads the same lengths
    // from the client's tables
    assert.ok(live.includes('accounts.outfit_ints_ok(p_colours, 5, 0, 15)'), 'torso and legs < 16');
    assert.ok(live.includes('p_colours[1] < 12 AND p_colours[4] < 6 AND p_colours[5] < 8'), 'hair, feet, skin');
});

test('the website gets the six functions and not the helpers', () => {
    const grants = live.match(/^GRANT .*/gm) ?? [];
    assert.equal(grants.length, GRANTED.length);
    for (const signature of GRANTED) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`), `revoke ${signature}`);
        assert.ok(live.includes(`GRANT EXECUTE ON FUNCTION accounts.${signature} TO website;`), `grant ${signature}`);
    }
    for (const signature of HELPERS) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`), `revoke ${signature}`);
        assert.ok(!live.includes(`ON FUNCTION accounts.${signature} TO website`), `${signature} stays internal`);
    }
    for (const grant of grants) {
        assert.ok(grant.includes('ON FUNCTION'), grant);
    }
});

test('every function is SECURITY DEFINER with a pinned search_path', () => {
    const headers = [...live.matchAll(/CREATE OR REPLACE FUNCTION accounts\.(\w+)\([\s\S]*?AS \$\$/g)];
    assert.equal(headers.length, GRANTED.length + HELPERS.length);
    for (const header of headers) {
        assert.ok(header[0].includes('SECURITY DEFINER SET search_path = public, pg_temp'), header[1]);
    }
});

test('the public read is the default look only, capped at 100 names', () => {
    const body = live.slice(live.indexOf('FUNCTION accounts.outfit_default_looks'));
    assert.ok(body.includes('o.is_default'), 'default only');
    assert.ok(body.includes('(p_usernames)[1:100]'), 'cap');
    assert.ok(!body.slice(0, body.indexOf('$$;')).includes('o.name'), 'no outfit names in public');
});

test('the rollback drops every function and the table', () => {
    for (const signature of [...GRANTED, ...HELPERS]) {
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${signature};`), `drop ${signature}`);
    }
    assert.ok(rollback.includes('-- DROP TABLE IF EXISTS "adventure_outfit";'), 'drop table');
});
