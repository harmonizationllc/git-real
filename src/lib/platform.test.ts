import { describe, expect, it } from "vitest";
import { detectPlatform } from "./platform";

// Contract: navigator.platform maps to the data-platform value; anything not macOS or Windows is linux.
describe("detectPlatform", () => {
  it.each([
    ["MacIntel", "macos"],
    ["MacARM", "macos"],
    ["Win32", "windows"],
    ["Linux x86_64", "linux"],
    ["X11", "linux"],
    ["", "linux"],
  ])("%s -> %s", (value, expected) => {
    expect(detectPlatform(value)).toBe(expected);
  });
});
