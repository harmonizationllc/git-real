import { describe, expect, it } from "vitest";

// Contract: test key events report AltGraph apart from Alt, as browsers do, so the AltGr guard
// does not swallow every Alt chord a test dispatches.
describe("test setup KeyboardEvent", () => {
  it("reports Alt but not AltGraph for an Alt press", () => {
    const e = new KeyboardEvent("keydown", { key: "f", code: "KeyF", altKey: true });
    expect(e.getModifierState("Alt")).toBe(true);
    expect(e.getModifierState("AltGraph")).toBe(false);
  });
});
