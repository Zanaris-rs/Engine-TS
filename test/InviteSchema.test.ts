import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 6 has to say the same thing in five places: the postgres migration
// that creates the tables, the mysql migration that mirrors it, the sqlite
// baseline (edited in place, see the README), and the three Prisma schemas the
// generated types come from. Same reasoning as EvidenceSchema.test.ts.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function modelBody(schema: string, model: string): string {
    const start = schema.indexOf(`\nmodel ${model} {`);
    assert.notEqual(start, -1, `model ${model}`);

    const body = schema.slice(start);
    return body.slice(0, body.indexOf('\n}'));
}

const postgresMigration = read('../prisma/postgres/migrations/006_invites/migration.sql');
const mysqlMigration = read('../prisma/multiworld/migrations/20260916000000_invites/migration.sql');
const sqliteBaseline = read('../prisma/singleworld/migrations/20251229170623_clean/migration.sql');

const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

const TABLES = ['invite', 'invite_attempt'];

const INVITE_COLUMNS = ['code', 'created_by_account_id', 'created_at', 'expires_at', 'claimed_by_account_id', 'claimed_at', 'revoked_at', 'revoked_reason'];

const INDEXES = ['invite_created_by_account_id_created_at_idx', 'invite_claimed_by_account_id_idx', 'invite_attempt_ip_created_at_idx'];

const MARKER = '-- === functions (task A2) ===';

test('the postgres migration creates both tables, with RLS on and no policy', () => {
    for (const table of TABLES) {
        assert.ok(postgresMigration.includes(`CREATE TABLE IF NOT EXISTS "${table}" (`), `CREATE TABLE ${table}`);
        assert.ok(postgresMigration.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`), `RLS ${table}`);
    }

    assert.ok(!postgresMigration.includes('CREATE POLICY'), 'no policies');
    assert.ok(!/\bREFERENCES\b/.test(postgresMigration), 'no foreign keys, like every other table');

    for (const grant of postgresMigration.match(/^GRANT .*/gm) ?? []) {
        assert.ok(grant.includes('ON FUNCTION'), grant);
    }
});

test('the invite flag is off for every account, old and new', () => {
    assert.ok(postgresMigration.includes('ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "invites_enabled" BOOLEAN NOT NULL DEFAULT false;'), 'postgres column');
    assert.ok(mysqlMigration.includes('ADD COLUMN `invites_enabled` BOOLEAN NOT NULL DEFAULT false'), 'mysql column');

    const account = sqliteBaseline.slice(sqliteBaseline.indexOf('CREATE TABLE "account" ('));
    assert.ok(account.slice(0, account.indexOf(');')).includes('"invites_enabled" BOOLEAN NOT NULL DEFAULT false'), 'sqlite column');

    for (const [name, schema] of Object.entries(schemas)) {
        assert.ok(/^\s+invites_enabled\s+Boolean\s+@default\(false\)$/m.test(modelBody(schema, 'account')), `${name}: account.invites_enabled`);
    }
});

test('a code is unique and has the Crockford shape the website generates', () => {
    assert.ok(postgresMigration.includes('CREATE UNIQUE INDEX IF NOT EXISTS "invite_code_key" ON "invite"("code");'), 'unique code');
    assert.ok(postgresMigration.includes('CHECK ("code" ~ \'^[0-9A-HJKMNP-TV-Z]{16}$\')'), 'code format');
    assert.ok(postgresMigration.includes('CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN (\'inviter\', \'staff\', \'banned\'))'), 'revoked_reason values');
});

test('every index exists in all three migrations', () => {
    for (const index of INDEXES) {
        assert.ok(postgresMigration.includes(`CREATE INDEX IF NOT EXISTS "${index}"`), `postgres ${index}`);
        assert.ok(mysqlMigration.includes(`\`${index}\``), `mysql ${index}`);
        assert.ok(sqliteBaseline.includes(`CREATE INDEX "${index}"`), `sqlite ${index}`);
    }

    assert.ok(mysqlMigration.includes('UNIQUE INDEX `invite_code_key`(`code`)'), 'mysql unique code');
    assert.ok(sqliteBaseline.includes('CREATE UNIQUE INDEX "invite_code_key" ON "invite"("code");'), 'sqlite unique code');
});

test('the mysql migration and the sqlite baseline carry both tables and every column', () => {
    for (const table of TABLES) {
        assert.ok(mysqlMigration.includes(`CREATE TABLE \`${table}\` (`), `mysql ${table}`);
        assert.ok(sqliteBaseline.includes(`CREATE TABLE "${table}" (`), `sqlite ${table}`);
    }

    for (const column of INVITE_COLUMNS) {
        assert.ok(postgresMigration.includes(`"${column}"`), `postgres invite.${column}`);
        assert.ok(mysqlMigration.includes(`\`${column}\``), `mysql invite.${column}`);
    }
});

test('all three Prisma schemas declare both models with every column', () => {
    for (const [name, schema] of Object.entries(schemas)) {
        const invite = modelBody(schema, 'invite');
        for (const column of INVITE_COLUMNS) {
            assert.ok(new RegExp(`^\\s+${column}\\s`, 'm').test(invite), `${name}: invite.${column}`);
        }
        assert.ok(/^\s+code\s+String\s+@unique$/m.test(invite), `${name}: invite.code @unique`);
        assert.ok(invite.includes('@@index([created_by_account_id, created_at(sort: Desc)])'), `${name}: maker index`);
        assert.ok(invite.includes('@@index([claimed_by_account_id])'), `${name}: claimer index`);

        const attempt = modelBody(schema, 'invite_attempt');
        assert.ok(attempt.includes('@@index([ip, created_at])'), `${name}: invite_attempt index`);
    }
});

test('the generated types know the new tables', () => {
    const types = read('../src/db/types.ts');
    assert.ok(types.includes('export type invite = {'), 'invite type');
    assert.ok(types.includes('export type invite_attempt = {'), 'invite_attempt type');
    assert.ok(types.includes('invites_enabled: Generated<boolean>;'), 'account.invites_enabled');
});

test('the DDL half defines no function, and keeps the marker task A2 appends below', () => {
    assert.ok(postgresMigration.includes(MARKER), 'marker');
    const ddl = postgresMigration.slice(0, postgresMigration.indexOf(MARKER));
    assert.ok(!ddl.includes('CREATE OR REPLACE FUNCTION'), 'no functions above the marker');
});
