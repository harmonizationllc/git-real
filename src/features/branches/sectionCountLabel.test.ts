import { describe, expect, it } from "vitest";
import { sectionCountLabel } from "./sectionCountLabel";

describe("sectionCountLabel", () => {
  it("shows only the total when not filtering", () => {
    expect(sectionCountLabel("Tags", 3, 3, false)).toBe("Tags (3)");
    expect(sectionCountLabel("Tags", 0, 2, false)).toBe("Tags (2)");
  });

  it("shows shown of total while filtering, even when they match", () => {
    expect(sectionCountLabel("Local", 1, 3, true)).toBe("Local (1 of 3)");
    expect(sectionCountLabel("Local", 3, 3, true)).toBe("Local (3 of 3)");
    expect(sectionCountLabel("Local", 0, 0, true)).toBe("Local (0 of 0)");
  });

  it("is the plain name while the list is loading", () => {
    expect(sectionCountLabel("Stashes", 0, undefined, false)).toBe("Stashes");
    expect(sectionCountLabel("Stashes", 0, undefined, true)).toBe("Stashes");
  });
});
