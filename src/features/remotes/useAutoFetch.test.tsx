import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOLDOWN_MS, useAutoFetchState } from "../../lib/store/autoFetch";
import { setAutoFetch, setAutoFetchInterval } from "../../lib/store/settingsActions";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { LOADING } from "./syncCopy";
import { useAutoFetch } from "./useAutoFetch";
import type { SyncActions } from "./useSyncActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
}));

const MINUTE = 60_000;
const store = () => useAutoFetchState.getState();
const OPEN_GATES = { fetch: null, pull: null, push: null, forcePush: null };
const sync = { autoFetch: vi.fn(), gates: OPEN_GATES as SyncActions["gates"] };

function mount() {
  return renderHook(() => useAutoFetch(1, sync));
}

/** Lets the mount-time fetch of a due repo happen and leaves the repo due again. */
function makeDue() {
  store().recordFetched(1, Date.now() - COOLDOWN_MS);
}

function focusWindow() {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  await resetSettings();
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useAutoFetchState.setState({ repos: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAutoFetch", () => {
  it("fetches once on mount", () => {
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
  });

  it("waits for the gates to load before the mount fetch", () => {
    const loading = {
      fetch: LOADING,
      pull: LOADING,
      push: LOADING,
      forcePush: LOADING,
    } as SyncActions["gates"];
    const { rerender } = renderHook(({ gates }) => useAutoFetch(1, { ...sync, gates }), {
      initialProps: { gates: loading },
    });
    expect(sync.autoFetch).not.toHaveBeenCalled();
    rerender({ gates: OPEN_GATES as SyncActions["gates"] });
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    rerender({ gates: { ...OPEN_GATES } as SyncActions["gates"] });
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
  });

  it("does not fetch on mount when the setting is off", async () => {
    await seedSettings({ fetch: { auto: false } });
    mount();
    expect(sync.autoFetch).not.toHaveBeenCalled();
  });

  it("fetches when the setting is turned on", async () => {
    await seedSettings({ fetch: { auto: false } });
    mount();
    act(() => setAutoFetch(true));
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
  });

  it("skips the mount trigger inside the cooldown", () => {
    store().recordFetched(1, Date.now());
    mount();
    expect(sync.autoFetch).not.toHaveBeenCalled();
  });

  it("skips every trigger while paused", () => {
    store().recordFailure(1);
    mount();
    act(() => store().request(1));
    focusWindow();
    expect(sync.autoFetch).not.toHaveBeenCalled();
  });

  it("fetches on a request for this repo and ignores other repos", () => {
    makeDue();
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    act(() => store().request(2));
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    act(() => store().request(1));
    expect(sync.autoFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches when the window regains focus", () => {
    makeDue();
    mount();
    focusWindow();
    expect(sync.autoFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches on the interval while focused", () => {
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    advance(5 * MINUTE);
    expect(sync.autoFetch).toHaveBeenCalledTimes(2);
    advance(5 * MINUTE);
    expect(sync.autoFetch).toHaveBeenCalledTimes(3);
  });

  it("restarts the interval from the last completed fetch", () => {
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    advance(4 * MINUTE);
    act(() => store().recordFetched(1, Date.now()));
    advance(1 * MINUTE);
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    advance(4 * MINUTE);
    expect(sync.autoFetch).toHaveBeenCalledTimes(2);
  });

  it("does not tick while the window is unfocused", () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    advance(5 * MINUTE);
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the configured interval", async () => {
    await seedSettings({ fetch: { intervalMinutes: 1 } });
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    advance(MINUTE);
    expect(sync.autoFetch).toHaveBeenCalledTimes(2);
  });

  it("re-arms the interval when the configured interval changes", () => {
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    advance(2 * MINUTE);
    act(() => setAutoFetchInterval(1));
    advance(1 * MINUTE);
    expect(sync.autoFetch).toHaveBeenCalledTimes(2);
    advance(1 * MINUTE);
    expect(sync.autoFetch).toHaveBeenCalledTimes(3);
  });

  it("fetches once when the setting is turned off and on while a tick is due", () => {
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    act(() => setAutoFetch(false));
    advance(10 * MINUTE);
    act(() => setAutoFetch(true));
    expect(sync.autoFetch).toHaveBeenCalledTimes(2);
  });

  it("skips a tick inside the cooldown", () => {
    const fetchedAt = Date.now();
    store().recordFetched(1, fetchedAt);
    mount();
    expect(sync.autoFetch).not.toHaveBeenCalled();
    advance(5 * MINUTE - 1_000);
    // The wall clock jumps back (suspend, NTP): the tick lands 1 s after the last fetch.
    vi.setSystemTime(fetchedAt);
    advance(1_000);
    expect(sync.autoFetch).not.toHaveBeenCalled();
  });

  it("stops the timer and ignores focus when the setting is turned off", () => {
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    act(() => setAutoFetch(false));
    advance(10 * MINUTE);
    focusWindow();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when the repo's entry is forgotten", () => {
    makeDue();
    store().request(1);
    mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    act(() => store().forget(1));
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
  });

  it("removes its listeners and timer on unmount", () => {
    const { unmount } = mount();
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
    unmount();
    advance(10 * MINUTE);
    focusWindow();
    act(() => store().request(1));
    expect(sync.autoFetch).toHaveBeenCalledTimes(1);
  });
});
