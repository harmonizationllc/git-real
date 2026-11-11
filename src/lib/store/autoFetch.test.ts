import { beforeEach, describe, expect, it } from "vitest";
import { dueNow, entryFor, useAutoFetchState } from "./autoFetch";
import type { AutoFetchEntry } from "./autoFetch";

const store = () => useAutoFetchState.getState();

const entry = (change: Partial<AutoFetchEntry>): AutoFetchEntry => ({
  lastFetchedAt: null,
  paused: false,
  requested: 0,
  manualRequested: 0,
  manualHandled: 0,
  ...change,
});

beforeEach(() => {
  useAutoFetchState.setState({ repos: {} });
});

describe("useAutoFetchState", () => {
  it("entryFor defaults to never fetched, not paused, no requests", () => {
    expect(entryFor(store(), 1)).toEqual({
      lastFetchedAt: null,
      paused: false,
      requested: 0,
      manualRequested: 0,
      manualHandled: 0,
    });
    expect(store().repos).toEqual({});
  });

  it("request bumps requested for that repo only", () => {
    store().request(1);
    store().request(1);
    expect(store().repos[1]?.requested).toBe(2);
    expect(entryFor(store(), 2).requested).toBe(0);
  });

  it("requestManual bumps manualRequested for that repo only", () => {
    store().requestManual(1);
    store().requestManual(1);
    expect(store().repos[1]?.manualRequested).toBe(2);
    expect(entryFor(store(), 2).manualRequested).toBe(0);
  });

  it("handleManual marks every outstanding manual request handled", () => {
    store().requestManual(1);
    store().requestManual(1);
    store().handleManual(1);
    expect(entryFor(store(), 1)).toMatchObject({ manualRequested: 2, manualHandled: 2 });
  });

  it("recordFetched stores the time and clears a pause", () => {
    store().recordFailure(1);
    store().recordFetched(1, 1000);
    expect(entryFor(store(), 1)).toMatchObject({ lastFetchedAt: 1000, paused: false });
  });

  it("recordFailure pauses without touching lastFetchedAt", () => {
    store().recordFetched(1, 1000);
    store().recordFailure(1);
    expect(entryFor(store(), 1)).toMatchObject({ lastFetchedAt: 1000, paused: true });
  });

  it("resume clears the pause and keeps lastFetchedAt", () => {
    store().recordFetched(1, 1000);
    store().recordFailure(1);
    store().resume(1);
    expect(entryFor(store(), 1)).toMatchObject({ lastFetchedAt: 1000, paused: false });
  });

  it("forget drops the entry", () => {
    store().recordFetched(1, 5);
    store().requestManual(1);
    store().forget(1);
    expect(store().repos).not.toHaveProperty("1");
  });

  it("dueNow is false while paused", () => {
    expect(dueNow(entry({ paused: true }), 1_000_000)).toBe(false);
  });

  it("dueNow ignores the pause for a silent retry but not the cooldown", () => {
    expect(dueNow(entry({ paused: true }), 1_000_000, true)).toBe(true);
    expect(dueNow(entry({ paused: true, lastFetchedAt: 10_000 }), 39_999, true)).toBe(false);
  });

  it("dueNow is true when never fetched", () => {
    expect(dueNow(entry({}), 0)).toBe(true);
  });

  it("dueNow honours the 30 s cooldown", () => {
    const e = entry({ lastFetchedAt: 10_000 });
    expect(dueNow(e, 39_999)).toBe(false);
    expect(dueNow(e, 40_000)).toBe(true);
  });
});
