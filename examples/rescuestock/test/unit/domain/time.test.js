// Time: Asia/Amman local times through Intl, never a constant offset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIME_ZONE, formatHHMM, formatLocalTime, localDay, localTimeOnDate, localToUtc, localToUtcMs, minutesBetween,
  normalizeTs, offsetMinutesAt, parseHHMM, parseTs, toTs, utcToLocal,
} from '../../../src/domain/time.js';

test('time: the zone is Asia/Amman and 10:00 local on the fixture date is 07:00Z (UTC+03:00)', () => {
  assert.equal(TIME_ZONE, 'Asia/Amman');
  assert.equal(localToUtc('2026-10-20T10:00'), '2026-10-20T07:00:00.000Z');
  assert.equal(localToUtc('2026-10-20T09:00'), '2026-10-20T06:00:00.000Z');
  assert.equal(utcToLocal('2026-10-20T07:00:00.000Z'), '2026-10-20T10:00');
  assert.equal(localTimeOnDate('2026-10-20', '11:20'), '2026-10-20T08:20:00.000Z');
  assert.equal(formatLocalTime('2026-10-20T07:40:00.000Z'), '10:40');
  assert.equal(offsetMinutesAt(Date.parse('2026-10-20T07:00:00.000Z')), 180);
});

test('time: the offset comes from the zone rules, not from a constant (Jordan changed its offset with DST until 2022)', () => {
  // 2021: UTC+2 in winter, UTC+3 in summer
  assert.equal(offsetMinutesAt(Date.parse('2021-01-15T12:00:00Z')), 120);
  assert.equal(offsetMinutesAt(Date.parse('2021-07-15T12:00:00Z')), 180);
  assert.equal(localToUtc('2021-01-15T12:00'), '2021-01-15T10:00:00.000Z');
  assert.equal(localToUtc('2021-07-15T12:00'), '2021-07-15T09:00:00.000Z');
  assert.equal(utcToLocal('2021-01-15T10:00:00.000Z'), '2021-01-15T12:00');
  // the spring-forward gap of 2021-03-26 (00:00 -> 01:00) does not exist as a local time
  assert.throws(() => localToUtc('2021-03-26T00:30'), RangeError);
  assert.equal(localToUtc('2021-03-26T01:30'), '2021-03-25T22:30:00.000Z');
  // round trip over every hour of a year that crosses both transitions
  for (let h = 0; h < 24 * 365; h += 1) {
    const ms = Date.parse('2021-01-01T00:00:00Z') + h * 3600000;
    const local = utcToLocal(ms);
    let back;
    try { back = localToUtcMs(local); } catch (e) { assert.fail(`${local}: ${e.message}`); }
    // in the repeated hour either instant is a valid answer for the same local text
    assert.equal(utcToLocal(back), local, local);
  }
});

test('time: localToUtc rejects malformed and impossible local date-times', () => {
  for (const bad of ['2026-10-20 10:00', '2026-10-20T10:00:00', '2026-10-20T24:00', '2026-02-30T10:00', '2026-13-01T10:00', '2026-10-20T10:60', 'tomorrow', '']) {
    assert.throws(() => localToUtc(bad), RangeError, bad);
  }
  assert.throws(() => localToUtc(null), TypeError);
  assert.throws(() => localToUtc(20261020), TypeError);
});

test('time: parseTs accepts ISO-8601 with an explicit zone and normalises to milliseconds-Z', () => {
  assert.equal(parseTs('2026-10-20T07:00:00.000Z'), Date.UTC(2026, 9, 20, 7));
  assert.equal(parseTs('2026-10-20T07:00:00Z'), Date.UTC(2026, 9, 20, 7));
  assert.equal(parseTs('2026-10-20T07:00Z'), Date.UTC(2026, 9, 20, 7));
  assert.equal(parseTs('2026-10-20T10:00:00+03:00'), Date.UTC(2026, 9, 20, 7));
  assert.equal(parseTs('2026-10-20T04:00:00.5-03:00'), Date.UTC(2026, 9, 20, 7, 0, 0, 500));
  assert.equal(normalizeTs('2026-10-20T10:00:00+03:00'), '2026-10-20T07:00:00.000Z');
  assert.equal(toTs(0), '1970-01-01T00:00:00.000Z');
  for (const bad of ['2026-10-20T07:00:00', '2026-10-20', '2026-02-30T07:00:00Z', 'x', '2026-10-20T25:00:00Z']) assert.throws(() => parseTs(bad), RangeError, bad);
  assert.throws(() => parseTs(5), TypeError);
  assert.throws(() => toTs(NaN), RangeError);
});

test('time: HH:MM parsing and formatting', () => {
  assert.equal(parseHHMM('10:30'), 630);
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('23:59'), 1439);
  for (const bad of ['24:00', '10:60', '9:30', '10:3', '1030', '10:30:00', '']) assert.throws(() => parseHHMM(bad), RangeError, bad);
  assert.equal(formatHHMM(630), '10:30');
  assert.equal(formatHHMM(0), '00:00');
  assert.throws(() => formatHHMM(1440), RangeError);
  assert.throws(() => formatHHMM(-1), RangeError);
  assert.throws(() => formatHHMM(1.5), RangeError);
});

test('time: localDay is the Asia/Amman calendar day (daily counters), not the UTC day', () => {
  assert.equal(localDay('2026-10-20T21:30:00.000Z'), '2026-10-21', '00:30 local is already the next day');
  assert.equal(localDay('2026-10-20T20:59:59.999Z'), '2026-10-20');
  assert.equal(localDay(Date.parse('2026-10-20T21:00:00.000Z')), '2026-10-21');
  assert.equal(minutesBetween(0, 90000), 1.5);
});
