import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 16, read back from the file. Its behaviour is rehearsed against a
// real postgres outside this repo (tests/migration-016.sql); what must not
// drift silently is pinned here: which functions the website may call, the
// fixed lists the site shares with the database, the mute rule (picks yes,
// words no) and what a staff "hide" on a log now blanks.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/016_adventure_persona/migration.sql');
const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

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
const fn = (name: string) => {
    const found = defined.get(name);
    assert.ok(found, name);
    return found;
};

const EMOTES = ['yes', 'no', 'think', 'bow', 'angry', 'cry', 'laugh', 'cheer', 'wave', 'beckon', 'clap', 'dance'];
const MOODS = ['neutral', 'happy', 'sad', 'angry', 'verymad', 'laugh', 'evillaugh', 'shock', 'confused', 'bored', 'shifty', 'scared', 'drunk', 'quiz'];
const quoted = (list: string[]) => list.map(item => `'${item}'`).join(', ');

const GRANTED = ['adventure_persona(text)', 'adventure_persona_save(text, text, int, int, text, text, text, text, jsonb, text, text, text, text, text, jsonb)'];
const WITHHELD = ['adventure_emotes()', 'adventure_moods()', 'adventure_goals(jsonb)', 'adventure_dialogue(jsonb)', 'adventure_persona_words(text, text, text, text, text, jsonb, jsonb)'];
const REPLACED = ['adventure_log_save', 'staff_adventure_resolve'];

test('the website may call exactly the two new functions', () => {
    for (const signature of GRANTED) {
        assert.ok(live.includes(`GRANT EXECUTE ON FUNCTION accounts.${signature} TO website;`), signature);
    }
    const grants = [...live.matchAll(/GRANT EXECUTE ON FUNCTION accounts\.(.+?) TO website;/g)].map(m => m[1]);
    assert.deepEqual(grants.sort(), [...GRANTED].sort());
    for (const signature of [...GRANTED, ...WITHHELD]) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`), `revoke ${signature}`);
    }
});

test('every function it defines is new and listed, or one of the two it replaces', () => {
    const listed = new Set([...GRANTED, ...WITHHELD].map(signature => signature.slice(0, signature.indexOf('('))));
    for (const name of defined.keys()) {
        assert.ok(listed.has(name) || REPLACED.includes(name), name);
    }
    for (const [name, { header }] of defined) {
        assert.match(header, /SECURITY DEFINER SET search_path = public, pg_temp AS $/m, `${name} is definer with a fixed path`);
    }
});

test('the fixed lists match the site and each other', () => {
    assert.ok(fn('adventure_emotes').body.includes(`ARRAY[${quoted(EMOTES)}]`), 'adventure_emotes()');
    assert.ok(fn('adventure_moods').body.includes(`ARRAY[${quoted(MOODS)}]`), 'adventure_moods()');
    assert.ok(live.includes(`CHECK ("signature_emote" IN (${quoted(EMOTES)}))`), 'the table check');
    assert.ok(live.includes("CHECK (\"god\" IN ('saradomin', 'zamorak', 'guthix'))"), 'gods');
});

test('a mute stops words, not picks', () => {
    const save = fn('adventure_persona_save').body;
    assert.ok(save.includes('accounts.adventure_author(p_username, false)'), 'the author check ignores the mute');
    assert.ok(save.includes('muted_until'), 'the mute is read separately');
    assert.ok(save.includes('adventure_persona_words('), 'and compared on words only');
    assert.ok(save.includes("RETURN 'muted'"));
});

test('About can keep the headline, and a staff hide blanks the persona', () => {
    assert.ok(fn('adventure_log_save').body.includes('p_headline IS NULL'), 'NULL keeps the headline');
    const resolve = fn('staff_adventure_resolve').body;
    assert.ok(resolve.includes("UPDATE public.adventure_persona SET title = '', examine = '', hangout = '', clan = '', goals = '[]', dialogue = '[]'"), 'the persona words go with the headline and about');
});

test('the rollback undoes everything', () => {
    for (const signature of [...GRANTED, ...WITHHELD]) {
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${signature};`), `drop ${signature}`);
    }
    assert.ok(rollback.includes('-- DROP TABLE IF EXISTS "adventure_persona";'));
    assert.ok(rollback.includes('013_adventurer_log'), 'says where the replaced functions come back from');
});

test('every schema has the table', () => {
    for (const [name, schema] of Object.entries(schemas)) {
        const model = schema.slice(schema.indexOf('model adventure_persona {'));
        assert.ok(schema.includes('model adventure_persona {'), name);
        for (const column of ['headline_colour', 'headline_effect', 'title', 'examine', 'hangout', 'clan', 'goals', 'god', 'home_town', 'playstyle', 'scene', 'signature_emote', 'dialogue', 'updated_at']) {
            assert.match(model.slice(0, model.indexOf('}')), new RegExp(`\\b${column}\\b`), `${name}.${column}`);
        }
    }
});
