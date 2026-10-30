// GR-18 Task 2: React consumers read the effective bindings resolved from the settings store.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../ipc";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { useEffectiveBindings, useKeycaps, useShortcutKeys } from "./useShortcutKeys";

vi.mock(import("../ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

beforeEach(async () => {
  vi.mocked(updateSettings).mockReset();
  await resetSettings();
});

describe("useShortcutKeys", () => {
  it("returns the default and then the seeded override", async () => {
    const { result } = renderHook(() => useShortcutKeys("fetch"));
    expect(result.current).toBe("Mod+Shift+F");
    await act(() => seedSettings({ shortcuts: { bindings: { fetch: "Mod+Alt+F" } } }));
    expect(result.current).toBe("Mod+Alt+F");
  });

  it("returns null for an unbound id", async () => {
    await seedSettings({ shortcuts: { bindings: { fetch: null } } });
    const { result } = renderHook(() => useShortcutKeys("fetch"));
    expect(result.current).toBeNull();
  });
});

describe("useEffectiveBindings", () => {
  it("is memoised on the bindings and recomputed after a change", async () => {
    const { result, rerender } = renderHook(() => useEffectiveBindings());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    await act(() => seedSettings({ shortcuts: { bindings: { fetch: "Mod+Alt+F" } } }));
    expect(result.current).not.toBe(first);
    expect(result.current.fetch).toBe("Mod+Alt+F");
  });

  it("keeps its result when a save replaces the bindings with an equal map", async () => {
    // The real backend answers every save with fresh section objects.
    const answer = vi.mocked(updateSettings).getMockImplementation()!;
    vi.mocked(updateSettings).mockImplementation(async (patch) =>
      structuredClone(await answer(patch)),
    );
    await seedSettings({ shortcuts: { bindings: { fetch: "Mod+Alt+F" } } });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useEffectiveBindings();
    });
    const first = result.current;
    const before = renders;
    await act(() => seedSettings({ appearance: { theme: "dark" } }));
    expect(result.current).toBe(first);
    expect(renders).toBe(before);
  });
});

// Contract (GR-18b §3): the learned keycaps, validated and stable across equal saves.
describe("useKeycaps", () => {
  it("is empty by default and shows the valid learned entries after a save", async () => {
    const { result } = renderHook(() => useKeycaps());
    expect(result.current).toEqual({});
    await act(() => seedSettings({ shortcuts: { bindings: {}, keycaps: { Q: "A", Enter: "B" } } }));
    expect(result.current).toEqual({ Q: "A" });
  });

  it("keeps its result when a save replaces the keycaps with an equal map", async () => {
    const answer = vi.mocked(updateSettings).getMockImplementation()!;
    vi.mocked(updateSettings).mockImplementation(async (patch) =>
      structuredClone(await answer(patch)),
    );
    await seedSettings({ shortcuts: { bindings: {}, keycaps: { Q: "A" } } });
    const { result } = renderHook(() => useKeycaps());
    const first = result.current;
    await act(() => seedSettings({ appearance: { theme: "dark" } }));
    expect(result.current).toBe(first);
  });
});
