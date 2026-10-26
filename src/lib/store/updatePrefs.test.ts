// GR-15 Cycle 1, Task 4 – tests for the updatePrefs zustand persist store.
//
// RED PHASE: `./updatePrefs` does not exist yet; every test in this file fails
// at module resolution time.

import { beforeEach, describe, expect, it } from "vitest";
import { CHECK_INTERVAL_MS, STARTUP_DELAY_MS, useUpdatePrefs } from "./updatePrefs"; // RED: module missing

beforeEach(() => {
  localStorage.clear();
  useUpdatePrefs.setState(useUpdatePrefs.getInitialState(), true);
});

// Contract: default values, persistence key/version, and the two timing constants.
describe("useUpdatePrefs defaults", () => {
  it("defaults checkOnStartup to true and lastCheckedAt to null", () => {
    expect(useUpdatePrefs.getInitialState()).toMatchObject({
      checkOnStartup: true,
      lastCheckedAt: null,
    });
  });

  it("exports CHECK_INTERVAL_MS = 86_400_000 (24 h in ms)", () => {
    expect(CHECK_INTERVAL_MS).toBe(86_400_000);
  });

  it("exports STARTUP_DELAY_MS = 10_000 (10 s in ms)", () => {
    expect(STARTUP_DELAY_MS).toBe(10_000);
  });
});

// Contract: persists under git-real.updatePrefs with version 1.
describe("useUpdatePrefs persistence", () => {
  it("persists under git-real.updatePrefs with version 1", () => {
    useUpdatePrefs.getState().setCheckOnStartup(false);
    const raw = localStorage.getItem("git-real.updatePrefs");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.version).toBe(1);
    expect(parsed.state).toMatchObject({ checkOnStartup: false });
  });

  it("persists only the data fields, not the setters", () => {
    useUpdatePrefs.getState().markChecked(1_000_000);
    const raw = localStorage.getItem("git-real.updatePrefs") as string;
    const keys = Object.keys(JSON.parse(raw).state).sort();
    expect(keys).toEqual(["checkOnStartup", "lastCheckedAt"]);
  });
});

// Contract: setCheckOnStartup updates the flag.
describe("useUpdatePrefs setCheckOnStartup", () => {
  it("setCheckOnStartup(false) disables the auto-check", () => {
    useUpdatePrefs.getState().setCheckOnStartup(false);
    expect(useUpdatePrefs.getState().checkOnStartup).toBe(false);
  });

  it("setCheckOnStartup(true) re-enables the auto-check", () => {
    useUpdatePrefs.getState().setCheckOnStartup(false);
    useUpdatePrefs.getState().setCheckOnStartup(true);
    expect(useUpdatePrefs.getState().checkOnStartup).toBe(true);
  });
});

// Contract: markChecked records the timestamp.
describe("useUpdatePrefs markChecked", () => {
  it("markChecked stores the supplied timestamp", () => {
    const ts = Date.now();
    useUpdatePrefs.getState().markChecked(ts);
    expect(useUpdatePrefs.getState().lastCheckedAt).toBe(ts);
  });

  it("markChecked replaces an earlier timestamp", () => {
    useUpdatePrefs.getState().markChecked(1_000);
    useUpdatePrefs.getState().markChecked(2_000);
    expect(useUpdatePrefs.getState().lastCheckedAt).toBe(2_000);
  });
});
