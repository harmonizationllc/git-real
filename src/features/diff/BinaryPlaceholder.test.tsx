import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChangeKind } from "../../lib/ipc";
import { fileDiff } from "../../test/diffFixtures";
import { BinaryPlaceholder } from "./BinaryPlaceholder";

const KINDS: [ChangeKind, string][] = [
  ["modified", "modified"],
  ["added", "added"],
  ["deleted", "deleted"],
  ["renamed", "renamed"],
  ["typeChange", "type change"],
  ["untracked", "untracked"],
  ["conflicted", "conflicted"],
];

const setup = (change: ChangeKind | null) =>
  render(<BinaryPlaceholder diff={fileDiff([], { isBinary: true, change })} />);

// Contract: the placeholder says there is no preview and names the kind of change.
describe("BinaryPlaceholder", () => {
  it("should say that no preview is available", () => {
    setup("modified");
    expect(screen.getByText("Binary file — no preview available")).toBeInTheDocument();
  });

  it.each(KINDS)("should show the lowercase word for %s", (kind, word) => {
    setup(kind);
    expect(screen.getByText(word)).toBeInTheDocument();
  });

  it("should show the status badge for the change", () => {
    setup("added");
    expect(screen.getByRole("img", { name: "added" })).toBeInTheDocument();
  });

  it("should show no badge or change word when the change is unknown", () => {
    setup(null);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("should still say that no preview is available when the change is unknown", () => {
    setup(null);
    expect(screen.getByText("Binary file — no preview available")).toBeInTheDocument();
  });

  it("should not be a live region", () => {
    setup("modified");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
