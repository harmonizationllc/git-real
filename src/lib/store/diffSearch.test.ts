import { beforeEach, describe, expect, it } from "vitest";
import { useDiffSearchStore } from "./diffSearch";

beforeEach(() => {
  useDiffSearchStore.setState({ query: "", wholeWord: false, matchCase: false });
});

describe("useDiffSearchStore", () => {
  it("starts empty with both toggles off", () => {
    const s = useDiffSearchStore.getState();
    expect(s.query).toBe("");
    expect(s.wholeWord).toBe(false);
    expect(s.matchCase).toBe(false);
  });

  it("setQuery and the two toggles update state", () => {
    const s = useDiffSearchStore.getState();
    s.setQuery("foo");
    s.toggleWholeWord();
    s.toggleMatchCase();
    expect(useDiffSearchStore.getState()).toMatchObject({
      query: "foo",
      wholeWord: true,
      matchCase: true,
    });
    s.toggleWholeWord();
    expect(useDiffSearchStore.getState().wholeWord).toBe(false);
  });
});
