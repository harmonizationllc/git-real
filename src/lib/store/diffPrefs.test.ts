import { beforeEach, describe, expect, it } from "vitest";
import { useDiffPrefs } from "./diffPrefs";

beforeEach(() => {
  localStorage.clear();
  useDiffPrefs.setState({ mode: "split", ignoreWhitespace: false });
});

// Contract: viewer preferences default to split mode, persist, and rehydrate.
describe("useDiffPrefs", () => {
  it("should default to split mode with whitespace shown", () => {
    expect(useDiffPrefs.getState()).toMatchObject({ mode: "split", ignoreWhitespace: false });
  });

  it("should update mode when setMode is called", () => {
    useDiffPrefs.getState().setMode("unified");
    expect(useDiffPrefs.getState().mode).toBe("unified");
  });

  it("should update ignoreWhitespace when setIgnoreWhitespace is called", () => {
    useDiffPrefs.getState().setIgnoreWhitespace(true);
    expect(useDiffPrefs.getState().ignoreWhitespace).toBe(true);
  });

  it("should persist the mode under git-real.diffPrefs", () => {
    useDiffPrefs.getState().setMode("unified");
    const raw = localStorage.getItem("git-real.diffPrefs");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state).toMatchObject({ mode: "unified" });
  });

  it("should persist only the preference values, not the setters", () => {
    useDiffPrefs.getState().setIgnoreWhitespace(true);
    const raw = localStorage.getItem("git-real.diffPrefs") as string;
    expect(Object.keys(JSON.parse(raw).state).sort()).toEqual(["ignoreWhitespace", "mode"]);
  });

  it("should rehydrate from storage", async () => {
    localStorage.setItem(
      "git-real.diffPrefs",
      JSON.stringify({ state: { mode: "unified", ignoreWhitespace: true }, version: 0 }),
    );
    await useDiffPrefs.persist.rehydrate();
    expect(useDiffPrefs.getState()).toMatchObject({ mode: "unified", ignoreWhitespace: true });
  });
});
