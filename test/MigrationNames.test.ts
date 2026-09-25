import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

// Prisma applies a directory's migrations in the order their names sort as
// text. With `0_init` .. `10_invite_genealogy`, text order put 10 straight
// after 0, so an empty postgres got migration 10 before the tables it reads.
// Three digits keep text order and number order the same up to 999.
//
// Production's `_prisma_migrations` records these names, so renaming a
// directory that has been applied means renaming its row too (see
// ec2-setup/apply-rename-migrations.sh), or prisma sees a new migration.

const names = readdirSync(new URL('../prisma/postgres/migrations', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

const number = (name: string) => Number(name.split('_')[0]);

test('every postgres migration is three digits, an underscore and a name', () => {
    for (const name of names) {
        assert.match(name, /^\d{3}_[a-z0-9_]+$/, name);
    }
});

test('text order is number order', () => {
    const byText = [...names].sort();
    const byNumber = [...names].sort((a, b) => number(a) - number(b));

    assert.deepEqual(byText, byNumber);
});

test('the numbers run from 000 with no gap and no repeat', () => {
    const numbers = names.map(number).sort((a, b) => a - b);

    assert.deepEqual(
        numbers,
        numbers.map((_, i) => i)
    );
});
