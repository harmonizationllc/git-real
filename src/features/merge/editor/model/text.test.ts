import { describe, expect, it } from "vitest";
import {
  MAX_EDIT_BYTES,
  decodeEditable,
  encodeForDisk,
  fileName,
  lineCount,
  placeholderReason,
} from "./text";

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

// Contract: only strict UTF-8 text under the size cap is editable; CRLF is normalised to LF and remembered.
describe("decodeEditable", () => {
  it("should decode UTF-8 and report no CRLF", () => {
    expect(decodeEditable(bytes("héllo\nworld\n"))).toEqual({
      text: "héllo\nworld\n",
      crlf: false,
    });
  });
  it("should normalise CRLF to LF and report crlf", () => {
    expect(decodeEditable(bytes("a\r\nb\r\n"))).toEqual({ text: "a\nb\n", crlf: true });
  });
  it("should decode an empty file as empty LF text", () => {
    expect(decodeEditable(new ArrayBuffer(0))).toEqual({ text: "", crlf: false });
  });
  it("should return tooLarge above MAX_EDIT_BYTES", () => {
    expect(decodeEditable(new ArrayBuffer(MAX_EDIT_BYTES + 1))).toBe("tooLarge");
  });
  it("should not report tooLarge at exactly MAX_EDIT_BYTES", () => {
    expect(decodeEditable(new ArrayBuffer(MAX_EDIT_BYTES))).not.toBe("tooLarge");
  });
  it("should decode text of exactly MAX_EDIT_BYTES in full", () => {
    const decoded = decodeEditable(new TextEncoder().encode("a".repeat(MAX_EDIT_BYTES)).buffer);
    expect(decoded).toEqual({ text: "a".repeat(MAX_EDIT_BYTES), crlf: false });
  });
  it("should return tooLarge for text one byte over MAX_EDIT_BYTES", () => {
    const over = new TextEncoder().encode("a".repeat(MAX_EDIT_BYTES + 1)).buffer;
    expect(decodeEditable(over)).toBe("tooLarge");
  });
  it("should return notText for invalid UTF-8", () => {
    expect(decodeEditable(new Uint8Array([0xff, 0xfe, 0x41]).buffer)).toBe("notText");
  });
  it("should return notText when the text holds U+0000", () => {
    expect(decodeEditable(bytes("a\u0000b"))).toBe("notText");
  });
  it("should cap the editable size at 2 MiB", () => {
    expect(MAX_EDIT_BYTES).toBe(2 * 1024 * 1024);
  });
});

// Contract: encodeForDisk restores CRLF only when the file originally used it.
describe("encodeForDisk", () => {
  it("should restore CRLF when asked", () => {
    expect(encodeForDisk("a\nb\n", true)).toBe("a\r\nb\r\n");
  });
  it("should round-trip CRLF text through decode and encode", () => {
    const decoded = decodeEditable(bytes("a\r\n\r\nb\r\n"));
    expect(decoded).toEqual({ text: "a\n\nb\n", crlf: true });
    expect(encodeForDisk("a\n\nb\n", true)).toBe("a\r\n\r\nb\r\n");
  });
  it("should leave LF text alone when CRLF is not asked for", () => {
    expect(encodeForDisk("a\nb\n", false)).toBe("a\nb\n");
  });
});

// Contract: lineCount is the number of "\n"-separated segments, so a final newline adds an empty line.
describe("lineCount", () => {
  it("should count newline-terminated lines plus the empty last segment", () => {
    expect(lineCount("a\nb\n")).toBe(3);
  });
  it("should count the empty text as one line", () => {
    expect(lineCount("")).toBe(1);
  });
});

// Contract: the file's last path segment, as the editors name it in copy.
describe("fileName", () => {
  it("should return the last path segment", () => {
    expect(fileName("deep/dir/image.png")).toBe("image.png");
  });

  it("should return a top-level path unchanged", () => {
    expect(fileName("README.md")).toBe("README.md");
  });
});

// Contract: decoded bytes win over an error; null while loading or when the text is editable.
describe("placeholderReason", () => {
  it("should be null while nothing has loaded", () => {
    expect(placeholderReason(null, null)).toBeNull();
  });

  it("should be null for editable text", () => {
    expect(placeholderReason({ text: "x", crlf: false }, null)).toBeNull();
  });

  it("should give the copy for bytes that cannot be edited", () => {
    expect(placeholderReason("tooLarge", null)).toBe("It is larger than 2 MB.");
    expect(placeholderReason("notText", null)).toBe("It is not UTF-8 text.");
  });

  it("should give the error's copy when there are no bytes", () => {
    expect(placeholderReason(null, { kind: "pathNotFound", message: "nope" })).toBe(
      "It is missing from the working tree.",
    );
  });

  it("should prefer bytes in hand over a later refetch error", () => {
    expect(
      placeholderReason({ text: "x", crlf: false }, { kind: "io", message: "flaky" }),
    ).toBeNull();
    expect(placeholderReason("notText", { kind: "io", message: "flaky" })).toBe(
      "It is not UTF-8 text.",
    );
  });
});
