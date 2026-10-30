import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHORTCUT_GROUPS,
  SHORTCUTS,
  activeKeys,
  formatKeyParts,
  formatKeys,
  matchesShortcut,
  resolveBindings,
  setActiveBindings,
  shortcut,
  validKeycaps,
} from "./index";
import type { ShortcutId } from "./index";
import type { ShortcutBindings } from "../ipc/types";

afterEach(() => {
  vi.restoreAllMocks();
  setActiveBindings(resolveBindings({}));
});

// Contract: 14-row registry with unique ids and keys.
describe("SHORTCUTS registry", () => {
  it("registry ids and keys are unique and the table has 14 rows", () => {
    expect(SHORTCUTS).toHaveLength(14);
    const ids = SHORTCUTS.map((s) => s.id);
    const keys = SHORTCUTS.map((s) => s.keys);
    expect(new Set(ids).size).toBe(14);
    expect(new Set(keys).size).toBe(14);
  });

  it("shortcut(id) returns the matching row", () => {
    const s = shortcut("fetch");
    expect(s.id).toBe("fetch");
    expect(s.keys).toBe("Mod+Shift+F");
  });

  it("SHORTCUT_GROUPS contains the four expected groups in order", () => {
    expect(SHORTCUT_GROUPS).toEqual(["Application", "Repository", "Commit", "Navigation"]);
  });

  it.each([
    ["palette", "Mod+K"],
    ["shortcuts", "Mod+/"],
    ["settings", "Mod+,"],
    ["openRepo", "Mod+O"],
    ["cloneRepo", "Mod+Shift+O"],
    ["closeTab", "Mod+W"],
    ["nextTab", "Mod+PageDown"],
    ["prevTab", "Mod+PageUp"],
    ["fetch", "Mod+Shift+F"],
    ["pull", "Mod+Shift+L"],
    ["push", "Mod+Shift+P"],
    ["fileHistory", "Mod+Shift+H"],
    ["commit", "Mod+Enter"],
    ["linkIssue", "Mod+Shift+I"],
  ] as [ShortcutId, string][])("shortcut %s has the correct keys", (id, keys) => {
    expect(shortcut(id).keys).toBe(keys);
  });
});

// Contract: matchesShortcut tests — each chord fires with ctrlKey and metaKey;
//           wrong modifiers and wrong key do not fire.
describe("matchesShortcut matrix", () => {
  function makeEvent(
    overrides: Partial<KeyboardEvent & { nativeEvent?: Partial<KeyboardEvent> }>,
  ): React.KeyboardEvent {
    const base = {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      key: "",
      code: "",
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 0,
      nativeEvent: {
        isComposing: false,
        keyCode: 0,
      },
    };
    const merged = { ...base, ...overrides };
    return merged as unknown as React.KeyboardEvent;
  }

  it.each([
    ["palette", { ctrlKey: true, key: "k", code: "KeyK" }],
    ["shortcuts", { ctrlKey: true, key: "/", code: "Slash" }],
    ["settings", { ctrlKey: true, key: ",", code: "Comma" }],
    ["openRepo", { ctrlKey: true, key: "o", code: "KeyO" }],
    ["cloneRepo", { ctrlKey: true, shiftKey: true, key: "O", code: "KeyO" }],
    ["closeTab", { ctrlKey: true, key: "w", code: "KeyW" }],
    ["nextTab", { ctrlKey: true, key: "PageDown", code: "PageDown" }],
    ["prevTab", { ctrlKey: true, key: "PageUp", code: "PageUp" }],
    ["fetch", { ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" }],
    ["pull", { ctrlKey: true, shiftKey: true, key: "L", code: "KeyL" }],
    ["push", { ctrlKey: true, shiftKey: true, key: "P", code: "KeyP" }],
    ["fileHistory", { ctrlKey: true, shiftKey: true, key: "H", code: "KeyH" }],
    ["commit", { ctrlKey: true, key: "Enter", code: "Enter" }],
    ["linkIssue", { ctrlKey: true, shiftKey: true, key: "I", code: "KeyI" }],
  ] as [ShortcutId, Partial<KeyboardEvent>][])(
    "exact chord fires for %s with ctrlKey",
    (id, overrides) => {
      expect(matchesShortcut(makeEvent(overrides), id)).toBe(true);
    },
  );

  it.each([
    ["palette", { metaKey: true, key: "k", code: "KeyK" }],
    ["fetch", { metaKey: true, shiftKey: true, key: "F", code: "KeyF" }],
    ["commit", { metaKey: true, key: "Enter", code: "Enter" }],
  ] as [ShortcutId, Partial<KeyboardEvent>][])(
    "exact chord fires for %s with metaKey",
    (id, overrides) => {
      expect(matchesShortcut(makeEvent(overrides), id)).toBe(true);
    },
  );

  it("missing Shift does not fire a Shift shortcut", () => {
    expect(matchesShortcut(makeEvent({ ctrlKey: true, key: "F", code: "KeyF" }), "fetch")).toBe(
      false,
    );
  });

  it("extra Shift does not fire a non-Shift shortcut", () => {
    expect(
      matchesShortcut(
        makeEvent({ ctrlKey: true, shiftKey: true, key: "k", code: "KeyK" }),
        "palette",
      ),
    ).toBe(false);
  });

  it("altKey prevents a match", () => {
    expect(
      matchesShortcut(
        makeEvent({ ctrlKey: true, altKey: true, key: "k", code: "KeyK" }),
        "palette",
      ),
    ).toBe(false);
  });

  it("wrong key does not fire", () => {
    expect(matchesShortcut(makeEvent({ ctrlKey: true, key: "x", code: "KeyX" }), "palette")).toBe(
      false,
    );
  });
});

// Contract: matches letters by code on non-Latin layout.
describe("matchesShortcut non-Latin layout", () => {
  it("matches letters by code on a non-Latin layout", () => {
    const e = {
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      key: "ф",
      code: "KeyF",
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 0,
      nativeEvent: { isComposing: false, keyCode: 0 },
    } as unknown as React.KeyboardEvent;
    expect(matchesShortcut(e, "fetch")).toBe(true);
  });

  it("matches , by Comma code", () => {
    const e = {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      key: "Dead",
      code: "Comma",
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 0,
      nativeEvent: { isComposing: false, keyCode: 0 },
    } as unknown as React.KeyboardEvent;
    expect(matchesShortcut(e, "settings")).toBe(true);
  });

  it("matches / by Slash code", () => {
    const e = {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      key: "Dead",
      code: "Slash",
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 0,
      nativeEvent: { isComposing: false, keyCode: 0 },
    } as unknown as React.KeyboardEvent;
    expect(matchesShortcut(e, "shortcuts")).toBe(true);
  });
});

// Contract: repeat, defaultPrevented and composing events are ignored.
describe("matchesShortcut composing/repeat/defaultPrevented", () => {
  const base = {
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    key: "k",
    code: "KeyK",
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    keyCode: 0,
    nativeEvent: { isComposing: false, keyCode: 0 },
  };

  it("ignores repeat events", () => {
    const e = { ...base, repeat: true, nativeEvent: { isComposing: false, keyCode: 0 } };
    expect(matchesShortcut(e as unknown as React.KeyboardEvent, "palette")).toBe(false);
  });

  it("ignores defaultPrevented events", () => {
    const e = { ...base, defaultPrevented: true, nativeEvent: { isComposing: false, keyCode: 0 } };
    expect(matchesShortcut(e as unknown as React.KeyboardEvent, "palette")).toBe(false);
  });

  it("ignores native isComposing events", () => {
    const e = { ...base, nativeEvent: { isComposing: true, keyCode: 0 } };
    expect(matchesShortcut(e as unknown as React.KeyboardEvent, "palette")).toBe(false);
  });

  it("ignores events with keyCode 229 (IME composing sentinel)", () => {
    const e = { ...base, nativeEvent: { isComposing: false, keyCode: 229 } };
    expect(matchesShortcut(e as unknown as React.KeyboardEvent, "palette")).toBe(false);
  });

  it("ignores React-level isComposing (if exposed)", () => {
    const e = { ...base, isComposing: true, nativeEvent: { isComposing: false, keyCode: 0 } };
    expect(matchesShortcut(e as unknown as React.KeyboardEvent, "palette")).toBe(false);
  });
});

// Contract: formatKeyParts returns platform-appropriate labels.
describe("formatKeyParts", () => {
  it("returns Ctrl label on Linux", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const parts = formatKeyParts("Mod+Shift+F");
    expect(parts).toEqual(["Ctrl", "Shift", "F"]);
  });

  it("returns Mac symbol labels on macOS", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const parts = formatKeyParts("Mod+Shift+F");
    expect(parts).toEqual(["⌘", "⇧", "F"]);
  });

  it("single key without Mod returns just the key label", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    expect(formatKeyParts("Mod+K")).toEqual(["Ctrl", "K"]);
  });
});

// Contract: formatKeys joins with + on Linux, nothing on macOS.
describe("formatKeys", () => {
  it("joins with + on Linux", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    expect(formatKeys("Mod+Shift+F")).toBe("Ctrl+Shift+F");
  });

  it("joins with nothing (no separator) on macOS", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(formatKeys("Mod+Shift+F")).toBe("⌘⇧F");
  });
});

// Contract (spec §5): overrides pass in registry order, then defaults pass.
describe("resolveBindings", () => {
  const defaults = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.keys]));

  it("resolves no overrides to every registry default", () => {
    expect(resolveBindings({})).toEqual(defaults);
  });

  it("applies a custom chord and keeps every other default", () => {
    expect(resolveBindings({ fetch: "Mod+Alt+F" })).toEqual({ ...defaults, fetch: "Mod+Alt+F" });
  });

  it("unbinds an id overridden with null", () => {
    expect(resolveBindings({ fetch: null })).toEqual({ ...defaults, fetch: null });
  });

  it.each<[ShortcutBindings, string]>([
    [{ nope: "Mod+Alt+N" }, "unknown id"],
    [{ fetch: "Shift+Mod+F" }, "malformed"],
    [{ fetch: "Shift+A" }, "unbindable"],
  ])("ignores %j (%s)", (overrides) => {
    expect(resolveBindings(overrides)).toEqual(defaults);
  });

  it("two overrides on one chord keep the first in registry order", () => {
    const resolved = resolveBindings({ pull: "Mod+G", fetch: "Mod+G" });
    expect(resolved.fetch).toBe("Mod+G");
    expect(resolved.pull).toBe("Mod+Shift+L");
  });

  it("an override on another id's default leaves that id unbound", () => {
    const resolved = resolveBindings({ fetch: "Mod+K" });
    expect(resolved.fetch).toBe("Mod+K");
    expect(resolved.palette).toBeNull();
  });
});

// Contract: matchesShortcut reads the active bindings.
describe("active bindings", () => {
  function press(overrides: Partial<KeyboardEvent>): React.KeyboardEvent {
    return {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      key: "",
      code: "",
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 0,
      nativeEvent: { isComposing: false, keyCode: 0 },
      ...overrides,
    } as unknown as React.KeyboardEvent;
  }

  it("activeKeys returns the defaults initially", () => {
    expect(activeKeys("fetch")).toBe("Mod+Shift+F");
  });

  it("a custom chord fires and the default no longer does", () => {
    setActiveBindings(resolveBindings({ fetch: "Mod+Alt+F" }));
    expect(activeKeys("fetch")).toBe("Mod+Alt+F");
    expect(
      matchesShortcut(press({ ctrlKey: true, altKey: true, key: "f", code: "KeyF" }), "fetch"),
    ).toBe(true);
    expect(
      matchesShortcut(press({ ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" }), "fetch"),
    ).toBe(false);
  });

  it("matchesShortcut fires a custom Alt chord by code", () => {
    setActiveBindings(resolveBindings({ fetch: "Mod+Alt+F" }));
    expect(
      matchesShortcut(press({ ctrlKey: true, altKey: true, key: "ф", code: "KeyF" }), "fetch"),
    ).toBe(true);
    expect(
      matchesShortcut(press({ ctrlKey: true, altKey: false, key: "ф", code: "KeyF" }), "fetch"),
    ).toBe(false);
  });

  it("an unbound id never matches", () => {
    setActiveBindings(resolveBindings({ fetch: null }));
    expect(activeKeys("fetch")).toBeNull();
    expect(
      matchesShortcut(press({ ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" }), "fetch"),
    ).toBe(false);
    expect(
      matchesShortcut(press({ ctrlKey: true, altKey: true, key: "f", code: "KeyF" }), "fetch"),
    ).toBe(false);
  });
});

// Contract (GR-18b §4): an AltGr press types a character and never fires a shortcut.
describe("matchesShortcut AltGraph", () => {
  it("matchesShortcut ignores an AltGraph event", () => {
    setActiveBindings(resolveBindings({ fetch: "Mod+Alt+E" }));
    const event = (altGraph: boolean) =>
      ({
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: true,
        key: "€",
        code: "KeyE",
        repeat: false,
        defaultPrevented: false,
        isComposing: false,
        keyCode: 0,
        getModifierState: () => altGraph,
      }) as unknown as KeyboardEvent;
    expect(matchesShortcut(event(true), "fetch")).toBe(false);
    expect(matchesShortcut(event(false), "fetch")).toBe(true);
  });
});

// Contract (GR-18b §3): learned keycaps are token-keyed and validated on read.
describe("validKeycaps", () => {
  it("validKeycaps keeps a learned entry", () => {
    expect(validKeycaps({ Q: "A" })).toEqual({ Q: "A" });
  });

  it("validKeycaps drops malformed and identity entries", () => {
    expect(validKeycaps({ Q: "Q", Enter: "A", q: "A", R: "ab", S: "é", T: "B" })).toEqual({
      T: "B",
    });
  });
});

// Contract (GR-18b §3): display swaps the chord key for the learned keycap.
describe("formatKeyParts / formatKeys with keycaps", () => {
  it("formatKeyParts replaces the last part with the learned keycap", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    expect(formatKeyParts("Mod+Alt+Q", { Q: "A" })).toEqual(["Ctrl", "Alt", "A"]);
    expect(formatKeyParts("Mod+Shift+F", { F: "U" })).toEqual(["Ctrl", "Shift", "U"]);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(formatKeyParts("Mod+Alt+Q", { Q: "A" })).toEqual(["⌘", "⌥", "A"]);
  });

  it("formatKeys with keycaps", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    expect(formatKeys("Mod+Alt+Q", { Q: "A" })).toBe("Ctrl+Alt+A");
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(formatKeys("Mod+Alt+Q", { Q: "A" })).toBe("⌘⌥A");
  });

  it("without a matching entry unchanged", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    expect(formatKeyParts("Mod+K", { Q: "A" })).toEqual(["Ctrl", "K"]);
    expect(formatKeyParts("Mod+K")).toEqual(["Ctrl", "K"]);
    expect(formatKeys("Mod+K", { Q: "A" })).toBe("Ctrl+K");
  });
});
