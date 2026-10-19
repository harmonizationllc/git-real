import { describe, expect, it } from "vitest";
import { fullDate, relativeTime } from "./relativeTime";

const now = Date.UTC(2026, 9, 19, 12, 0, 0);
const t = (secondsAgo: number) => now / 1000 - secondsAgo;
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

// Contract: relativeTime(unixSeconds, nowMs) renders an English phrase, "just now" under 45s.
describe("relativeTime recent", () => {
  it.each([
    [10, "just now"],
    [44, "just now"],
  ])("should say just now for %i seconds ago", (secs, text) => {
    expect(relativeTime(t(secs), now)).toBe(text);
  });

  it("should say just now for a time in the future", () => {
    expect(relativeTime(now / 1000 + 3600, now)).toBe("just now");
  });

  it("should say just now for a commit made at exactly now", () => {
    expect(relativeTime(now / 1000, now)).toBe("just now");
  });
});

describe("relativeTime minutes and hours", () => {
  it.each([
    [45, "1 minute ago"],
    [30 * MIN, "30 minutes ago"],
    [44 * MIN, "44 minutes ago"],
    [45 * MIN, "1 hour ago"],
    [21 * HOUR, "21 hours ago"],
  ])("should format %i seconds ago as %s", (secs, text) => {
    expect(relativeTime(t(secs), now)).toBe(text);
  });
});

describe("relativeTime days", () => {
  it.each([
    [22 * HOUR, "yesterday"],
    [3 * DAY, "3 days ago"],
    [25 * DAY, "25 days ago"],
  ])("should format %i seconds ago as %s", (secs, text) => {
    expect(relativeTime(t(secs), now)).toBe(text);
  });
});

describe("relativeTime months and years", () => {
  it.each([
    [26 * DAY, "last month"],
    [6 * 30 * DAY, "6 months ago"],
    [11 * 30 * DAY, "last year"],
    [3 * 365 * DAY, "3 years ago"],
  ])("should format %i seconds ago as %s", (secs, text) => {
    expect(relativeTime(t(secs), now)).toBe(text);
  });
});

// Contract: fullDate is the viewer's locale rendering of the Unix-seconds timestamp.
describe("fullDate", () => {
  it("should equal the locale string of the epoch", () => {
    expect(fullDate(0)).toBe(new Date(0).toLocaleString());
  });

  it("should convert seconds, not milliseconds", () => {
    expect(fullDate(1_700_000_000)).toBe(new Date(1_700_000_000_000).toLocaleString());
  });
});
