import { beforeEach, describe, expect, it } from "vitest";
import { dueNow, entryFor, useAutoFetchState } from "./autoFetch";

const store = () => useAutoFetchState.getState();

beforeEach(() => {
  useAutoFetchState.setState({ repos: {} });
});

describe("useAutoFetchState", () => {
  it("entryFor defaults to never fetched, not paused, no requests", () => {
    expect(entryFor(store(), 1)).toEqual({ lastFetchedAt: null, paused: false, requested: 0 });
    expect(store().repos).toEqual({});
  });

  it("request bumps requested for that repo only", () => {
    store().request(1);
    store().request(1);
    expect(store().repos[1]?.requested).toBe(2);
    expect(entryFor(store(), 2).requested).toBe(0);
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
    store().forget(1);
    expect(store().repos).not.toHaveProperty("1");
  });

  it("dueNow is false while paused", () => {
    expect(dueNow({ lastFetchedAt: null, paused: true, requested: 0 }, 1_000_000)).toBe(false);
  });

  it("dueNow is true when never fetched", () => {
    expect(dueNow({ lastFetchedAt: null, paused: false, requested: 0 }, 0)).toBe(true);
  });

  it("dueNow honours the 30 s cooldown", () => {
    const entry = { lastFetchedAt: 10_000, paused: false, requested: 0 };
    expect(dueNow(entry, 39_999)).toBe(false);
    expect(dueNow(entry, 40_000)).toBe(true);
  });
});
