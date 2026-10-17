import { describe, expect, it } from "vitest";
import { fileDiff } from "../../../test/diffFixtures";
import { encodingLabel, encodingNotice, isDecoded } from "./encoding";

// Contract: every encoding has a human label.
describe("encodingLabel", () => {
  it("should label every encoding", () => {
    expect(
      (["utf8", "utf16Le", "utf16Be", "utf32Le", "utf32Be"] as const).map(encodingLabel),
    ).toEqual(["UTF-8", "UTF-16 LE", "UTF-16 BE", "UTF-32 LE", "UTF-32 BE"]);
  });
});

// Contract: the toolbar notice describes decoded diffs and encoding changes.
describe("encodingNotice", () => {
  it("should be null for an ordinary diff", () => {
    expect(encodingNotice(fileDiff([]))).toBeNull();
  });
  it("should say decoded when both sides share an encoding", () => {
    expect(encodingNotice(fileDiff([], { oldEncoding: "utf16Le", newEncoding: "utf16Le" }))).toBe(
      "Decoded from UTF-16 LE",
    );
  });
  it("should say decoded when only the new side has an encoding", () => {
    expect(encodingNotice(fileDiff([], { oldEncoding: null, newEncoding: "utf16Be" }))).toBe(
      "Decoded from UTF-16 BE",
    );
  });
  it("should say decoded when only the old side has an encoding", () => {
    expect(encodingNotice(fileDiff([], { oldEncoding: "utf32Le", newEncoding: null }))).toBe(
      "Decoded from UTF-32 LE",
    );
  });
  it("should report a change when the encodings differ", () => {
    expect(encodingNotice(fileDiff([], { oldEncoding: "utf8", newEncoding: "utf16Le" }))).toBe(
      "Encoding changed from UTF-8 to UTF-16 LE",
    );
  });
});

// Contract: isDecoded is true when either side was decoded.
describe("isDecoded", () => {
  it("should be false when neither side has an encoding", () => {
    expect(isDecoded(fileDiff([]))).toBe(false);
  });
  it("should be true when the new side has an encoding", () => {
    expect(isDecoded(fileDiff([], { newEncoding: "utf16Le" }))).toBe(true);
  });
  it("should be true when the old side has an encoding", () => {
    expect(isDecoded(fileDiff([], { oldEncoding: "utf16Le" }))).toBe(true);
  });
});
