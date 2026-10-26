import { beforeEach, describe, expect, it } from "vitest";
import { CHECK_INTERVAL_MS, STARTUP_DELAY_MS, useUpdateState } from "./updateState";

beforeEach(() => {
  localStorage.clear();
  useUpdateState.setState(useUpdateState.getInitialState(), true);
});

describe("useUpdateState", () => {
  it("defaults lastCheckedAt to null", () => {
    expect(useUpdateState.getInitialState().lastCheckedAt).toBeNull();
  });

  it("exports the 24 h interval and the 10 s startup delay", () => {
    expect(CHECK_INTERVAL_MS).toBe(86_400_000);
    expect(STARTUP_DELAY_MS).toBe(10_000);
  });

  it("markChecked stores and replaces the timestamp", () => {
    useUpdateState.getState().markChecked(1_000);
    expect(useUpdateState.getState().lastCheckedAt).toBe(1_000);
    useUpdateState.getState().markChecked(2_000);
    expect(useUpdateState.getState().lastCheckedAt).toBe(2_000);
  });

  it("persists only lastCheckedAt under git-real.updateState", () => {
    useUpdateState.getState().markChecked(1_000_000);
    const parsed = JSON.parse(localStorage.getItem("git-real.updateState") as string);
    expect(parsed.version).toBe(1);
    expect(parsed.state).toEqual({ lastCheckedAt: 1_000_000 });
  });
});
