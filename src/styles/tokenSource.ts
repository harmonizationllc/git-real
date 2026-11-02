import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source-level access to tokens.css for the style pin tests.
export const css = readFileSync(resolve(__dirname, "tokens.css"), "utf8");

/** Parse custom-property declarations in a CSS fragment into a map of property → value. */
export function parseBlock(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

/** Everything inside the first `{ … }` that follows `selector` in tokens.css. */
export function selectorBlock(selector: string): string {
  const idx = css.indexOf(selector);
  if (idx === -1) return "";
  const start = css.indexOf("{", idx);
  let depth = 1;
  let i = start + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(start + 1, i - 1);
}

/** The declarations of the selector block nested inside the prefers-color-scheme: dark media query. */
export function mediaDarkBlock(): string {
  const mediaIdx = css.indexOf("@media (prefers-color-scheme: dark)");
  if (mediaIdx === -1) return "";
  const mediaOpen = css.indexOf("{", mediaIdx);
  const selectorOpen = css.indexOf("{", mediaOpen + 1);
  let depth = 1;
  let i = selectorOpen + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(selectorOpen + 1, i - 1);
}
