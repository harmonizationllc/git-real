import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChangeKind } from "../../lib/ipc";
import { StatusBadge } from "./StatusBadge";

const CASES: [ChangeKind, string, string][] = [
  ["added", "A", "added"],
  ["modified", "M", "modified"],
  ["deleted", "D", "deleted"],
  ["renamed", "R", "renamed"],
  ["typeChange", "T", "type change"],
  ["untracked", "U", "untracked"],
  ["conflicted", "C", "conflicted"],
];

// Contract: one letter and one accessible name per change kind.
describe("StatusBadge", () => {
  it.each(CASES)("should show the letter for %s when rendered", (kind, letter) => {
    render(<StatusBadge kind={kind} />);
    expect(screen.getByRole("img")).toHaveTextContent(new RegExp(`^${letter}$`));
  });

  it.each(CASES)("should expose the kind words as the accessible name for %s", (kind, _l, name) => {
    render(<StatusBadge kind={kind} />);
    expect(screen.getByRole("img", { name })).toBeInTheDocument();
  });

  it.each(CASES)("should expose data-kind for %s so CSS can colour it", (kind) => {
    render(<StatusBadge kind={kind} />);
    expect(screen.getByRole("img")).toHaveAttribute("data-kind", kind);
  });
});
