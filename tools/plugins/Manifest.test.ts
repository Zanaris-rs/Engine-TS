import assert from 'assert';
import { describe, it } from 'node:test';

import { compareVersions } from '#tools/plugins/Manifest.js';

describe('version comparison', () => {
    it('orders by major, then minor, then patch', () => {
        assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
        assert.ok(compareVersions('1.2.0', '1.10.0') < 0, '1.2 must sort below 1.10, not as a decimal');
        assert.ok(compareVersions('1.2.3', '1.2.3') === 0);
        assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    });

    it('treats a missing component as zero', () => {
        assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
    });
});
