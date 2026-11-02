import { describe, expect, it } from "vitest";
import { declarationsOf } from "./cssRules";

const css = `
/* .root { gap: 9px } in a comment is ignored */
.root { display: flex; }
.other, .root:hover { gap: 2px; }
.rooted { gap: 3px; }
.pill[data-hidden="true"] { visibility: hidden; }
`;

// Contract: declarationsOf reads every top-level rule that names the class, comments excluded.
describe("declarationsOf", () => {
  it("should join the declarations of every rule whose selector list names the class", () => {
    expect(declarationsOf(css, "root")).toMatch(/display:\s*flex/);
    expect(declarationsOf(css, "root")).toMatch(/gap:\s*2px/);
  });

  it("should ignore comments, longer class names and other classes", () => {
    expect(declarationsOf(css, "root")).not.toMatch(/9px|3px/);
    expect(declarationsOf(css, "pill")).toMatch(/visibility:\s*hidden/);
    expect(declarationsOf(css, "missing")).toBe("");
  });
});
