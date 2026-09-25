import assert from 'node:assert/strict';
import test from 'node:test';

import { requestShutdown, resetShutdownForTests } from '#/util/Shutdown.js';

test('the first request stops, the second is ignored', () => {
    resetShutdownForTests();
    let stops = 0;
    assert.equal(
        requestShutdown(() => stops++),
        true
    );
    assert.equal(
        requestShutdown(() => stops++),
        false
    );
    assert.equal(stops, 1);
});
