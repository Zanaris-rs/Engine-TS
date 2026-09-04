import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultWorldConfig, getDatabaseUrl, normalizeWorldConfig } from '#/util/WorldConfig.js';

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

test('normalizeWorldConfig drops keys that are not part of the schema', () => {
    const config = normalizeWorldConfig({ db: { backend: 'postgres' }, nonsense: true });

    assert.equal(config.db.backend, 'postgres');
    assert.equal('nonsense' in config, false);
});
