import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chordFromEvent,
  chordToString,
  codeForKey,
  isAltGraph,
  isBindable,
  isKeyToken,
  keycapFromEvent,
  modifierLabels,
  parseChord,
} from "./chord";
import { SHORTCUTS } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
});

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    key: "",
    code: "",
    ...overrides,
  } as KeyboardEvent;
}

describe("parseChord / chordToString", () => {
  it.each(SHORTCUTS.map((s) => [s.id, s.keys]))("round-trips the default %s", (_id, keys) => {
    expect(chordToString(parseChord(keys)!)).toBe(keys);
  });

  it.each([
    "Mod+A",
    "Alt+1",
    "F5",
    "Shift+F5",
    "Mod+Space",
    "Mod+ArrowLeft",
    "Mod+Alt+Shift+\\",
    "Mod+`",
  ])("accepts %s", (keys) => {
    const chord = parseChord(keys);
    expect(chord).not.toBeNull();
    expect(chordToString(chord!)).toBe(keys);
  });

  it("parses each modifier flag", () => {
    expect(parseChord("Mod+Alt+Shift+\\")).toEqual({
      mod: true,
      alt: true,
      shift: true,
      key: "\\",
    });
    expect(parseChord("F5")).toEqual({ mod: false, alt: false, shift: false, key: "F5" });
  });

  it.each([
    ["Shift+Mod+F", "order"],
    ["Mod+Mod+F", "duplicate"],
    ["Mod+Escape", "Escape"],
    ["Mod+Tab", "Tab"],
    ["Mod", "bare modifier"],
    ["", "empty"],
    ["Mod+f", "lower case"],
    ["Ctrl+F", "unknown modifier"],
  ])("rejects %s (%s)", (keys) => {
    expect(parseChord(keys)).toBeNull();
  });
});

describe("codeForKey", () => {
  it.each([
    ["F", "KeyF"],
    ["1", "Digit1"],
    [",", "Comma"],
    [".", "Period"],
    ["/", "Slash"],
    [";", "Semicolon"],
    ["'", "Quote"],
    ["[", "BracketLeft"],
    ["]", "BracketRight"],
    ["\\", "Backslash"],
    ["-", "Minus"],
    ["=", "Equal"],
    ["`", "Backquote"],
    ["PageUp", "PageUp"],
    ["F5", "F5"],
  ])("maps %s to %s", (key, code) => {
    expect(codeForKey(key)).toBe(code);
  });
});

describe("chordFromEvent", () => {
  it("chordFromEvent reads the physical key on a non-Latin layout", () => {
    expect(
      chordFromEvent(keyEvent({ code: "KeyF", key: "а", ctrlKey: true, altKey: true })),
    ).toEqual({ mod: true, alt: true, shift: false, key: "F" });
    expect(
      chordFromEvent(keyEvent({ code: "Digit1", key: "!", shiftKey: true, ctrlKey: true })),
    ).toEqual({ mod: true, alt: false, shift: true, key: "1" });
    expect(chordFromEvent(keyEvent({ code: "Comma", key: ",", metaKey: true }))).toEqual({
      mod: true,
      alt: false,
      shift: false,
      key: ",",
    });
    expect(chordFromEvent(keyEvent({ code: "F5", key: "F5" }))).toEqual({
      mod: false,
      alt: false,
      shift: false,
      key: "F5",
    });
    expect(
      chordFromEvent(keyEvent({ code: "ControlLeft", key: "Control", ctrlKey: true })),
    ).toBeNull();
    expect(chordFromEvent(keyEvent({ code: "Escape", key: "Escape" }))).toBeNull();
    expect(chordFromEvent(keyEvent({ code: "MediaPlayPause" }))).toBeNull();
  });

  it("reads named keys verbatim", () => {
    expect(chordFromEvent(keyEvent({ code: "ArrowLeft", key: "ArrowLeft", altKey: true }))).toEqual(
      { mod: false, alt: true, shift: false, key: "ArrowLeft" },
    );
  });

  it("reads a React keyboard event", () => {
    const e = {
      ...keyEvent({ code: "KeyK", key: "k", ctrlKey: true }),
    } as unknown as React.KeyboardEvent;
    expect(chordFromEvent(e)).toEqual({ mod: true, alt: false, shift: false, key: "K" });
  });
});

describe("isBindable", () => {
  it.each([
    ["Mod+A", true],
    ["Alt+A", true],
    ["F5", true],
    ["Shift+F5", true],
    ["Shift+A", false],
    ["Enter", false],
    ["Space", false],
  ])("%s is bindable: %s", (keys, expected) => {
    expect(isBindable(parseChord(keys)!)).toBe(expected);
  });
});

describe("modifierLabels", () => {
  it("returns Ctrl and Alt on Linux", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    expect(modifierLabels()).toEqual({ mod: "Ctrl", alt: "Alt" });
  });

  it("returns the Mac symbols on macOS", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(modifierLabels()).toEqual({ mod: "⌘", alt: "⌥" });
  });
});

// Contract (GR-18b §4): AltGr produces characters, never shortcuts.
describe("isAltGraph", () => {
  it("is true when getModifierState reports AltGraph", () => {
    expect(isAltGraph(keyEvent({ getModifierState: () => true }))).toBe(true);
  });

  it("is false when getModifierState reports no AltGraph", () => {
    expect(isAltGraph(keyEvent({ getModifierState: () => false }))).toBe(false);
  });

  it("is false when the event has no getModifierState", () => {
    expect(isAltGraph(keyEvent({}))).toBe(false);
  });

  it("chordFromEvent returns null under AltGraph", () => {
    expect(
      chordFromEvent(
        keyEvent({
          code: "KeyE",
          key: "€",
          ctrlKey: true,
          altKey: true,
          getModifierState: () => true,
        }),
      ),
    ).toBeNull();
  });
});

// Contract (GR-18b §3): the keycap a physical key prints, learned from a press.
describe("keycapFromEvent", () => {
  const chord = (key: string) => ({ mod: true, alt: true, shift: false, key });

  it("keycapFromEvent records the keycap for a Dvorak letter", () => {
    expect(keycapFromEvent(keyEvent({ code: "KeyQ", key: "a" }), chord("Q"))).toBe("A");
  });

  it("returns the same letter when the layout matches", () => {
    expect(keycapFromEvent(keyEvent({ code: "KeyQ", key: "q" }), chord("Q"))).toBe("Q");
  });

  it("ignores a shifted glyph", () => {
    expect(
      keycapFromEvent(keyEvent({ code: "Digit1", key: "!", shiftKey: true }), chord("1")),
    ).toBeNull();
  });

  it("ignores a Shift press on a punctuation key, which types the shifted glyph", () => {
    expect(
      keycapFromEvent(keyEvent({ code: "Comma", key: ";", shiftKey: true }), chord(",")),
    ).toBeNull();
  });

  it("ignores a Shift press on a digit key, which types the shifted glyph", () => {
    expect(
      keycapFromEvent(keyEvent({ code: "Digit7", key: "/", shiftKey: true }), chord("7")),
    ).toBeNull();
  });

  it("ignores an accented glyph", () => {
    expect(keycapFromEvent(keyEvent({ code: "KeyA", key: "å" }), chord("A"))).toBeNull();
  });

  it("ignores a dead key", () => {
    expect(keycapFromEvent(keyEvent({ code: "KeyA", key: "Dead" }), chord("A"))).toBeNull();
  });

  it("ignores F-keys and named keys", () => {
    expect(keycapFromEvent(keyEvent({ code: "F5", key: "F5" }), chord("F5"))).toBeNull();
    expect(keycapFromEvent(keyEvent({ code: "Enter", key: "Enter" }), chord("Enter"))).toBeNull();
  });

  it("ignores a single-character key on a named-key chord", () => {
    expect(keycapFromEvent(keyEvent({ code: "Space", key: " " }), chord("Space"))).toBeNull();
    expect(keycapFromEvent(keyEvent({ code: "Enter", key: "A" }), chord("Enter"))).toBeNull();
  });

  it("records a swapped punctuation keycap", () => {
    expect(keycapFromEvent(keyEvent({ code: "Semicolon", key: "," }), chord(";"))).toBe(",");
  });

  it("records an upper-case keycap for Shift+letter", () => {
    expect(keycapFromEvent(keyEvent({ code: "KeyQ", key: "A", shiftKey: true }), chord("Q"))).toBe(
      "A",
    );
  });
});

describe("isKeyToken", () => {
  it("is true for chord key tokens", () => {
    for (const s of ["A", "7", ",", "F5", "Enter"]) expect(isKeyToken(s)).toBe(true);
  });

  it("is false for anything else", () => {
    for (const s of ["a", "é", "ab", "Escape"]) expect(isKeyToken(s)).toBe(false);
  });
});
