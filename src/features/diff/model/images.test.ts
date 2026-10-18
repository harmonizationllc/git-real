import { describe, expect, it } from "vitest";
import { isImagePath, mimeFor } from "./images";

// Contract: raster image extensions (case-insensitive) preview as images; SVG diffs as text.
describe("isImagePath", () => {
  it.each([
    "a.png",
    "b.JPG",
    "c.jpeg",
    "d.gif",
    "e.webp",
    "f.bmp",
    "g.ico",
    "h.avif",
    "dir.v2/i.PNG",
  ])("should treat %s as an image", (p) => expect(isImagePath(p)).toBe(true));
  it.each(["a.svg", "b.ts", "noext", "x.png.bak", ".png", "dir.png/file"])(
    "should not treat %s as an image",
    (p) => expect(isImagePath(p)).toBe(false),
  );
});

// Contract: mimeFor maps known extensions and falls back to octet-stream.
describe("mimeFor", () => {
  it.each([
    ["a.png", "image/png"],
    ["a.JPG", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.bmp", "image/bmp"],
    ["a.ico", "image/x-icon"],
    ["a.avif", "image/avif"],
  ])("should map %s to %s", (p, mime) => expect(mimeFor(p)).toBe(mime));
  it("should fall back to application/octet-stream for unknown extensions", () => {
    expect(mimeFor("a.txt")).toBe("application/octet-stream");
  });
  it("should fall back to application/octet-stream when there is no extension", () => {
    expect(mimeFor("noext")).toBe("application/octet-stream");
  });
});
