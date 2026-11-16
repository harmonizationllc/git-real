import { beforeEach, describe, expect, it } from "vitest";
import { useMessages } from "../../lib/store/messages";
import { useToasts } from "../../lib/store/toasts";
import { autoStashNotice, toastAutoStash } from "./autoStashToast";

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  useMessages.setState({ messages: [], unread: false });
});

// Contract: each reapply outcome maps to the spec's copy, variant, stickiness and details.
describe("autoStashNotice", () => {
  it("should report applied as a success toast that times out", () => {
    expect(autoStashNotice({ files: 3, reapply: "applied", detail: null }, "feature/x")).toEqual({
      text: "Stashed 3 changed files and reapplied them on feature/x.",
      variant: "success",
      sticky: false,
      details: null,
    });
  });

  it("should report conflicts as a sticky error toast", () => {
    expect(autoStashNotice({ files: 3, reapply: "conflicts", detail: null }, "feature/x")).toEqual({
      text: "Switched to feature/x, but reapplying your 3 stashed files hit conflicts. Resolve them, then drop the stash.",
      variant: "error",
      sticky: true,
      details: null,
    });
  });

  it("should report appliedNotDropped as an info toast that times out", () => {
    expect(
      autoStashNotice({ files: 3, reapply: "appliedNotDropped", detail: null }, "feature/x"),
    ).toEqual({
      text: "Reapplied your 3 stashed files on feature/x; the stash could not be dropped and is still listed.",
      variant: "info",
      sticky: false,
      details: null,
    });
  });

  it("should report kept as a sticky error toast carrying the pop output as details", () => {
    expect(
      autoStashNotice({ files: 3, reapply: "kept", detail: "error: boom" }, "feature/x"),
    ).toEqual({
      text: "Switched to feature/x, but your 3 changed files could not be reapplied. They are in the stash list.",
      variant: "error",
      sticky: true,
      details: "error: boom",
    });
  });

  it("should use the singular for one file", () => {
    expect(autoStashNotice({ files: 1, reapply: "applied", detail: null }, "main").text).toBe(
      "Stashed 1 changed file and reapplied it on main.",
    );
    expect(autoStashNotice({ files: 1, reapply: "conflicts", detail: null }, "main").text).toBe(
      "Switched to main, but reapplying your 1 stashed file hit conflicts. Resolve them, then drop the stash.",
    );
  });
});

// Contract: toastAutoStash shows the notice through the toast store, and nothing for null.
describe("toastAutoStash", () => {
  it("should show nothing when no stash was taken", () => {
    toastAutoStash(null, "x");
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("should append the notice for a report", () => {
    toastAutoStash({ files: 2, reapply: "kept", detail: "boom" }, "x");
    expect(useToasts.getState().toasts).toEqual([
      expect.objectContaining({
        text: "Switched to x, but your 2 changed files could not be reapplied. They are in the stash list.",
        details: "boom",
        variant: "error",
        sticky: true,
      }),
    ]);
  });
});
