import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cronMatches, parseCron } from '../src/cron.ts';

// 2026-01-05T03:30:00Z is Monday 09:30 in Asia/Dhaka (UTC+6).
const MONDAY_0930_DHAKA = new Date('2026-01-05T03:30:00Z');

describe('cron matching', () => {
  it('matches exact minute and hour in the given zone', () => {
    assert.equal(cronMatches('30 9 * * *', MONDAY_0930_DHAKA, 'Asia/Dhaka'), true);
    assert.equal(cronMatches('30 9 * * *', MONDAY_0930_DHAKA, 'UTC'), false, 'it is 03:30 UTC');
    assert.equal(cronMatches('30 3 * * *', MONDAY_0930_DHAKA, 'UTC'), true);
  });

  it('matches weekdays, ranges, lists and steps', () => {
    assert.equal(cronMatches('30 9 * * 1', MONDAY_0930_DHAKA, 'Asia/Dhaka'), true, 'Monday');
    assert.equal(cronMatches('30 9 * * 0', MONDAY_0930_DHAKA, 'Asia/Dhaka'), false, 'not Sunday');
    assert.equal(cronMatches('30 9 * * 1-5', MONDAY_0930_DHAKA, 'Asia/Dhaka'), true);
    assert.equal(cronMatches('*/15 * * * *', MONDAY_0930_DHAKA, 'Asia/Dhaka'), true, '30 % 15');
    assert.equal(cronMatches('*/7 * * * *', MONDAY_0930_DHAKA, 'Asia/Dhaka'), false, '30 % 7');
    assert.equal(cronMatches('30 9 5 1 *', MONDAY_0930_DHAKA, 'Asia/Dhaka'), true, 'Jan 5th');
    assert.equal(cronMatches('30 9 * * 7', MONDAY_0930_DHAKA, 'Asia/Dhaka'), false, '7 = Sunday');
  });

  it('applies either-day semantics when both day fields are restricted', () => {
    // Jan 5th OR Wednesday: the date matches even though the weekday does not.
    assert.equal(cronMatches('30 9 5 * 3', MONDAY_0930_DHAKA, 'Asia/Dhaka'), true);
    // Jan 9th OR Wednesday: neither matches on a Monday the 5th.
    assert.equal(cronMatches('30 9 9 * 3', MONDAY_0930_DHAKA, 'Asia/Dhaka'), false);
  });

  it('rejects malformed expressions loudly', () => {
    assert.throws(() => parseCron('* * * *'), /five fields/);
    assert.throws(() => parseCron('61 * * * *'), /minute/);
    assert.throws(() => parseCron('* 25 * * *'), /hour/);
    assert.throws(() => parseCron('* * * * 1-9'), /day-of-week/);
    assert.throws(() => parseCron('*/0 * * * *'), /step/);
  });
});
