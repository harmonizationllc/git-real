import { describe, expect, it } from "vitest";
import type { AppError } from "../../lib/ipc";
import {
  MAKE_COMMIT_FIRST,
  NO_REMOTES_TITLE,
  createErrorText,
  displayError,
  statusText,
  tagCountLabel,
} from "./tagCopy";

const err = (kind: AppError["kind"], message = "raw"): AppError => ({ kind, message });

// Contract: the fixed copy strings.
describe("tagCopy constants", () => {
  it("should word the no-remotes title and the unborn hint verbatim", () => {
    expect([NO_REMOTES_TITLE, MAKE_COMMIT_FIRST]).toEqual([
      "No remotes configured",
      "Make a commit first",
    ]);
  });
});

describe("statusText", () => {
  it("should say Pushed ‹name› to ‹remote›. for a push", () => {
    expect(statusText({ kind: "pushed", name: "v1", remote: "origin" })).toBe(
      "Pushed v1 to origin.",
    );
  });

  it("should say Deleted ‹name› from ‹remote›. for a remote delete", () => {
    expect(statusText({ kind: "deletedRemote", name: "v1", remote: "origin" })).toBe(
      "Deleted v1 from origin.",
    );
  });
});

describe("displayError", () => {
  it("should give tagNotFound the refreshed copy and keep its kind", () => {
    expect(displayError(err("tagNotFound", "no tag named v1"), "v1")).toEqual({
      kind: "tagNotFound",
      message: "Tag v1 no longer exists; the list has been refreshed.",
    });
  });

  it("should return tagNotFound unchanged when the name is null", () => {
    const e = err("tagNotFound", "no tag named v1");
    expect(displayError(e, null)).toBe(e);
  });

  it.each(["networkFailed", "remoteNotFound", "io"] as const)(
    "should return a %s error as the same object",
    (kind) => {
      const e = err(kind);
      expect(displayError(e, "v1")).toBe(e);
    },
  );
});

describe("createErrorText", () => {
  it("should name the tag for invalidTagName", () => {
    expect(createErrorText(err("invalidTagName"), "bad..x")).toBe(
      "bad..x is not a valid tag name.",
    );
  });

  it("should name the tag for tagExists", () => {
    expect(createErrorText(err("tagExists"), "v1")).toBe("A tag named v1 already exists.");
  });

  it("should say the commit is gone for commitNotFound", () => {
    expect(createErrorText(err("commitNotFound"), "v1")).toBe("That commit no longer exists.");
  });

  it("should ask for a message for emptyMessage", () => {
    expect(createErrorText(err("emptyMessage"), "v1")).toBe(
      "Enter a message for an annotated tag.",
    );
  });

  it("should pass git's text through for operationFailed", () => {
    expect(createErrorText(err("operationFailed", "gpg failed"), "v1")).toBe("gpg failed");
  });

  it("should pass the message through for an io error", () => {
    expect(createErrorText(err("io", "disk full"), "v1")).toBe("disk full");
  });
});

describe("tagCountLabel", () => {
  it("should show only the total when not filtering", () => {
    expect(tagCountLabel(3, 3, false)).toBe("Tags (3)");
  });

  it("should show m of n while filtering", () => {
    expect(tagCountLabel(1, 3, true)).toBe("Tags (1 of 3)");
  });

  it("should show 0 of 0 while filtering an empty list", () => {
    expect(tagCountLabel(0, 0, true)).toBe("Tags (0 of 0)");
  });

  it("should ignore the shown count when not filtering", () => {
    expect(tagCountLabel(0, 2, false)).toBe("Tags (2)");
  });
});
