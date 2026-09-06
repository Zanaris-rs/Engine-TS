import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as bcrypt from 'bcrypt-ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bcrypt-contract.json', import.meta.url), 'utf8')) as {
    password: string;
    hash: string;
    cost: number;
};

test('the committed hash verifies the lowercased password', () => {
    assert.equal(bcrypt.compareSync(fixture.password.toLowerCase(), fixture.hash), true);
    assert.equal(bcrypt.compareSync('hunter2', fixture.hash), true);
});

test('the hash does not verify the password as typed - the login server lowercases first', () => {
    assert.equal(bcrypt.compareSync('Hunter2', fixture.hash), false);
});

test('a hash produced here verifies the fixture password, at the agreed cost', () => {
    const hash = bcrypt.hashSync(fixture.password.toLowerCase(), fixture.cost);

    assert.match(hash, new RegExp(`^\\$2[aby]\\$${fixture.cost}\\$`));
    assert.equal(bcrypt.compareSync('hunter2', hash), true);
});
