import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultWorldConfig, getDatabaseUrl, normalizeWorldConfig, resolveLocalStaffLevel } from '#/util/WorldConfig.js';

function withDatabaseUrl<T>(value: string | undefined, fn: () => T): T {
    const previous = process.env.DATABASE_URL;

    if (typeof value === 'undefined') {
        delete process.env.DATABASE_URL;
    } else {
        process.env.DATABASE_URL = value;
    }

    try {
        return fn();
    } finally {
        if (typeof previous === 'undefined') {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = previous;
        }
    }
}

test('mysql builds its url from the host fields and ignores DATABASE_URL', () => {
    const config = createDefaultWorldConfig();
    config.db.backend = 'mysql';

    withDatabaseUrl('postgresql://someone:secret@example.invalid:5432/postgres', () => {
        assert.equal(getDatabaseUrl(config), 'mysql://root:password@localhost:3306/lostcity');
    });
});

test('postgres prefers DATABASE_URL over the configured url', () => {
    const config = createDefaultWorldConfig();
    config.db.backend = 'postgres';
    config.db.url = 'postgresql://from-config/postgres';

    withDatabaseUrl('postgresql://from-env/postgres', () => {
        assert.equal(getDatabaseUrl(config), 'postgresql://from-env/postgres');
    });

    withDatabaseUrl(undefined, () => {
        assert.equal(getDatabaseUrl(config), 'postgresql://from-config/postgres');
    });
});

test('db.url defaults to an empty string so mergeConfig can coerce it', () => {
    assert.equal(createDefaultWorldConfig().db.url, '');
    assert.equal(normalizeWorldConfig({ db: { backend: 'postgres', url: 'postgresql://x/y' } }).db.url, 'postgresql://x/y');
});

test('account.autoCreate is off unless a world.json asks for it', () => {
    assert.equal(createDefaultWorldConfig().account.autoCreate, false);
    assert.equal(normalizeWorldConfig({}).account.autoCreate, false);
    assert.equal(normalizeWorldConfig({ account: { autoCreate: true } }).account.autoCreate, true);
});

test('the legacy website.registration key is carried over, inverted', () => {
    // registration: false meant "do not register on the website", i.e. in-game
    assert.equal(normalizeWorldConfig({ website: { registration: false } }).account.autoCreate, true);
    assert.equal(normalizeWorldConfig({ website: { registration: true } }).account.autoCreate, false);
    // an explicit account block always wins
    assert.equal(normalizeWorldConfig({ website: { registration: false }, account: { autoCreate: false } }).account.autoCreate, false);
});

test('normalizeWorldConfig drops keys that are not part of the schema', () => {
    const config = normalizeWorldConfig({ db: { backend: 'postgres' }, nonsense: true });

    assert.equal(config.db.backend, 'postgres');
    assert.equal('nonsense' in config, false);
});

test('bind hosts default to every interface and accept loopback', () => {
    const defaults = createDefaultWorldConfig();
    assert.equal(defaults.web.host, '0.0.0.0');
    assert.equal(defaults.node.host, '0.0.0.0');
    const local = normalizeWorldConfig({ web: { host: '127.0.0.1' }, node: { host: '127.0.0.1' } });
    assert.equal(local.web.host, '127.0.0.1');
    assert.equal(local.node.host, '127.0.0.1');
});

test('the local staff level is unset by default and follows production when unset', () => {
    const config = createDefaultWorldConfig();
    assert.equal(config.node.localStaffLevel, -1);
    config.node.production = false;
    assert.equal(resolveLocalStaffLevel(config), 4);
    config.node.production = true;
    assert.equal(resolveLocalStaffLevel(config), 0);
});

test('an explicit local staff level wins over production', () => {
    assert.equal(resolveLocalStaffLevel(normalizeWorldConfig({ node: { production: false, localStaffLevel: 0 } })), 0);
    assert.equal(resolveLocalStaffLevel(normalizeWorldConfig({ node: { production: true, localStaffLevel: 4 } })), 4);
    assert.equal(resolveLocalStaffLevel(normalizeWorldConfig({ node: { localStaffLevel: 2 } })), 2);
});
