import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { liveOpportunities } from '../../src/client/page-helpers.js';

describe('liveOpportunities (reset chance gating)', () => {
  const now = 1_790_000_000_000;

  it('keeps only chances whose expiry is in the future', () => {
    const available = [
      { expireAt: now + 60_000 },
      { expireAt: now - 1 }, // expired one tick ago
      { expireAt: now }, // expiring exactly now is not redeemable
      { expireAt: new Date(now + 120_000).toISOString() }, // ISO string expiry in the future
      null,
      { noExpire: true },
    ];
    const live = liveOpportunities(available, now);
    assert.equal(live.length, 2);
    assert.deepEqual(live[0], { expireAt: now + 60_000 });
  });

  it('accepts epoch-second expiries like toMs does', () => {
    const live = liveOpportunities([{ expireAt: 1_790_000_060 }], now);
    assert.equal(live.length, 1);
  });

  it('returns an empty list for malformed input instead of throwing', () => {
    assert.deepEqual(liveOpportunities(null, now), []);
    assert.deepEqual(liveOpportunities(undefined, now), []);
    assert.deepEqual(liveOpportunities([{ expireAt: 'not-a-date' }], now), []);
    assert.deepEqual(liveOpportunities([{ expireAt: now + 1 }], Number.NaN), []);
  });
});
