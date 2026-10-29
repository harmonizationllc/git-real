import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chordFromEvent,
  chordToString,
  codeForKey,
  isBindable,
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
