import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_FAMILY_TOKENS, PLATFORMS, TEXT_SIZE_TOKENS } from "./fontTokens";

// Contract: the exported token names match what tokens.css declares.
const css = readFileSync(resolve(__dirname, "tokens.css"), "utf8");
const rootStart = css.indexOf(":root {");
const rootBlock = css.slice(rootStart, css.indexOf("}", rootStart));

describe("fontTokens", () => {
  it("lists the --text-* tokens declared on :root, in order", () => {
    const declared = [...rootBlock.matchAll(/(--text-[\w-]+)\s*:/g)].map((m) => m[1]);
    expect([...TEXT_SIZE_TOKENS]).toEqual(declared);
  });

  it("declares every family token on :root", () => {
    for (const token of FONT_FAMILY_TOKENS) expect(rootBlock).toContain(`${token}:`);
  });

  it("has a data-platform block for each platform", () => {
    for (const platform of PLATFORMS) {
      expect(css).toContain(`:root[data-platform="${platform}"] {`);
    }
  });
});
