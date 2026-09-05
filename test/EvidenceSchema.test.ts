import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 4 has to say the same thing in five places: the postgres migration
// that actually creates the tables, the mysql migration that mirrors it, and
// the three Prisma schemas that every backend's generated types come from. The
// checks below are the cheap half of keeping them in step - a table that exists
// on one backend and not another is a runtime failure on whichever host runs
// the odd one out, and nothing else in the test suite would notice.
//
// The functions, grants and reap() land in the same postgres file in task M4b;
// this file deliberately asserts nothing about them beyond the placeholder that
// marks where they go.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const postgresMigration = read('../prisma/postgres/migrations/4_evidence_and_records/migration.sql');
const mysqlMigration = read('../prisma/multiworld/migrations/20260908000000_evidence_and_records/migration.sql');

const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

// The sqlite baseline is a single file, edited in place - see the engine
// README, "The regenerated sqlite baseline" - so migration 4's tables are in
// 20251229170623_clean rather than a migration of their own.
const sqliteBaseline = read('../prisma/singleworld/migrations/20251229170623_clean/migration.sql');

const TABLES = ['report_input', 'report_chat', 'punishment', 'staff_spawn', 'economy_snapshot', 'economy_flow'];

// New columns on the existing report table, in the order the plan lists them.
const REPORT_COLUMNS = ['uuid', 'offender_account_id', 'offender_session_uuid', 'offender_coord', 'resolved_at', 'resolution', 'resolved_by_account_id', 'staff_note'];

// Every index migration 4 creates, including the ones on the three log tables
// that have been unindexed since 0_init and now have both a reader and a
// retention sweep.
const INDEXES = [
    'report_uuid_idx',
    'report_offender_account_id_timestamp_idx',
    'report_input_report_uuid_seq_idx',
    'report_chat_report_uuid_at_idx',
    'session_wealth_timestamp_idx',
    'session_wealth_session_uuid_timestamp_idx',
    'public_chat_timestamp_idx',
    'public_chat_session_uuid_timestamp_idx',
    'private_chat_timestamp_idx',
    'private_chat_account_id_timestamp_idx',
    'punishment_issued_at_idx',
    'punishment_account_id_idx',
    'staff_spawn_created_at_idx',
    'economy_snapshot_profile_taken_at_idx',
    'economy_flow_profile_taken_at_idx'
];

test('the postgres migration creates every new table, with RLS on and no policy', () => {
    for (const table of TABLES) {
        assert.ok(postgresMigration.includes(`CREATE TABLE IF NOT EXISTS "${table}" (`), `CREATE TABLE ${table}`);
        assert.ok(postgresMigration.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`), `RLS ${table}`);
    }

    // 0_init's rule, still: RLS on with no policies means nothing reaches these
    // rows except a SECURITY DEFINER function running as the owner.
    assert.ok(!postgresMigration.includes('CREATE POLICY'), 'no policies');

    // No grant on schema public or anything in it, which is what makes a leaked
    // `website` credential useless against these tables. Still true once M4b
    // appends its block: every grant there is EXECUTE on a function.
    for (const grant of postgresMigration.match(/^GRANT .*/gm) ?? []) {
        assert.ok(grant.includes('ON FUNCTION'), grant);
    }
});

test('the postgres migration adds every new report column, all nullable', () => {
    for (const column of REPORT_COLUMNS) {
        assert.ok(postgresMigration.includes(`ALTER TABLE "report" ADD COLUMN IF NOT EXISTS "${column}"`), `report.${column}`);
    }

    // Rows written before this migration know none of it, so nothing here may
    // be NOT NULL - a single one would fail the migration on the live table.
    for (const line of postgresMigration.split('\n')) {
        if (line.startsWith('ALTER TABLE "report" ADD COLUMN')) {
            assert.ok(!line.includes('NOT NULL'), line);
        }
    }
});

test('the postgres migration creates every index, and report.uuid is not unique', () => {
    for (const index of INDEXES) {
        assert.ok(postgresMigration.includes(`CREATE INDEX IF NOT EXISTS "${index}"`), index);
    }

    // Several reports against the same offender inside one capture window share
    // a uuid, and every row older than migration 4 has none at all.
    assert.ok(!postgresMigration.includes('CREATE UNIQUE INDEX'), 'no unique index');
});

test('the postgres migration keeps the marker M4b appends its functions below', () => {
    // The file is applied once, as a whole, after both halves exist. Losing this
    // line is how the second half ends up in a migration of its own.
    assert.ok(postgresMigration.includes('-- === functions (task M4b) ==='), 'placeholder');

    // Nothing above the marker may define a function: the DDL half has to be
    // readable on its own, and M4b owns everything after it.
    const ddl = postgresMigration.slice(0, postgresMigration.indexOf('-- === functions (task M4b) ==='));
    assert.ok(!ddl.includes('CREATE OR REPLACE FUNCTION'), 'no functions above the marker');
});

test('the mysql migration mirrors the same tables, columns and indexes', () => {
    for (const table of TABLES) {
        assert.ok(mysqlMigration.includes(`CREATE TABLE \`${table}\` (`), `CREATE TABLE ${table}`);
    }

    for (const column of REPORT_COLUMNS) {
        assert.ok(mysqlMigration.includes(`ADD COLUMN \`${column}\``), `report.${column}`);
    }

    for (const index of INDEXES) {
        assert.ok(mysqlMigration.includes(`\`${index}\``), index);
    }
});

test('the sqlite baseline carries the same tables, columns and indexes', () => {
    for (const table of TABLES) {
        assert.ok(sqliteBaseline.includes(`CREATE TABLE "${table}" (`), `CREATE TABLE ${table}`);
    }

    for (const index of INDEXES) {
        assert.ok(sqliteBaseline.includes(`CREATE INDEX "${index}"`), index);
    }

    const report = sqliteBaseline.slice(sqliteBaseline.indexOf('CREATE TABLE "report" ('));
    for (const column of REPORT_COLUMNS) {
        assert.ok(report.slice(0, report.indexOf(');')).includes(`"${column}"`), `report.${column}`);
    }
});

test('all three Prisma schemas declare every new model', () => {
    for (const [name, schema] of Object.entries(schemas)) {
        for (const table of TABLES) {
            assert.ok(schema.includes(`model ${table} {`), `${name}: model ${table}`);
        }
    }
});

test('all three Prisma schemas declare every new report column and index', () => {
    for (const [name, schema] of Object.entries(schemas)) {
        const model = schema.slice(schema.indexOf('\nmodel report {'));
        const body = model.slice(0, model.indexOf('\n}'));

        for (const column of REPORT_COLUMNS) {
            assert.ok(new RegExp(`^\\s+${column}\\s`, 'm').test(body), `${name}: report.${column}`);
        }

        assert.ok(body.includes('@@index([uuid])'), `${name}: report_uuid_idx`);
        assert.ok(body.includes('@@index([offender_account_id, timestamp(sort: Desc)])'), `${name}: report_offender_account_id_timestamp_idx`);
    }
});

test('all three Prisma schemas index the three log tables the sweeps and evidence read', () => {
    const expected: [string, string[]][] = [
        ['session_wealth', ['@@index([timestamp])', '@@index([session_uuid, timestamp])']],
        ['public_chat', ['@@index([timestamp])', '@@index([session_uuid, timestamp])']],
        ['private_chat', ['@@index([timestamp])', '@@index([account_id, timestamp])']]
    ];

    for (const [name, schema] of Object.entries(schemas)) {
        for (const [table, indexes] of expected) {
            const model = schema.slice(schema.indexOf(`\nmodel ${table} {`));
            const body = model.slice(0, model.indexOf('\n}'));

            for (const index of indexes) {
                assert.ok(body.includes(index), `${name}: ${table} ${index}`);
            }
        }
    }
});

test('the json census columns take the shape each backend can actually store', () => {
    // jsonb on postgres, plain text on the two backends without a json type -
    // the writer hands all three the same JSON string.
    assert.ok(/items\s+Json\b/.test(schemas.postgres), 'postgres: items Json');
    assert.ok(/tracked\s+Json\b/.test(schemas.postgres), 'postgres: tracked Json');
    assert.ok(postgresMigration.includes('"items" JSONB NOT NULL'), 'postgres: items JSONB');
    assert.ok(postgresMigration.includes('"tracked" JSONB NOT NULL'), 'postgres: tracked JSONB');

    assert.ok(/items\s+String\s*$/m.test(schemas.singleworld), 'sqlite: items String');
    assert.ok(/tracked\s+String\s*$/m.test(schemas.singleworld), 'sqlite: tracked String');

    assert.ok(/items\s+String\s+@db\.Text/.test(schemas.multiworld), 'mysql: items @db.Text');
    assert.ok(/tracked\s+String\s+@db\.Text/.test(schemas.multiworld), 'mysql: tracked @db.Text');
});

test('the input evidence is bytes on every backend', () => {
    for (const [name, schema] of Object.entries(schemas)) {
        const model = schema.slice(schema.indexOf('\nmodel report_input {'));
        assert.ok(/data\s+Bytes/.test(model.slice(0, model.indexOf('\n}'))), `${name}: report_input.data`);
    }

    assert.ok(postgresMigration.includes('"data" BYTEA NOT NULL'), 'postgres: bytea');
    assert.ok(mysqlMigration.includes('`data` LONGBLOB NOT NULL'), 'mysql: longblob');
    assert.ok(sqliteBaseline.includes('"data" BLOB NOT NULL'), 'sqlite: blob');
});
