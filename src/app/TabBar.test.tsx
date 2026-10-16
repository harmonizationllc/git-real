import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RepoTab } from "../lib/store/repoTabs";
import { TabBar } from "./TabBar";

const tab = (id: number, name: string): RepoTab => ({
  id,
  summary: { path: `/r/${name}`, name, headBranch: "main", isBare: false },
});
const tabs = [tab(1, "alpha"), tab(2, "beta")];

function setup(activeId: number | null = 1, list: RepoTab[] = tabs) {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<TabBar tabs={list} activeId={activeId} onActivate={onActivate} onClose={onClose} />);
  return { user, onActivate, onClose };
}

// Contract: one tab per repo, in order, named by the repo name.
describe("TabBar rendering", () => {
  it("renders a tab per repo", () => {
    setup();
    const names = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("tab shows the repo path as its title", () => {
    setup();
    expect(screen.getByRole("tab", { name: "alpha" })).toHaveAttribute("title", "/r/alpha");
  });

  it("empty tab list renders only the plus button", () => {
    setup(null, []);
    expect(screen.getByRole("tablist", { name: "Open repositories" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Start screen" })).toBeInTheDocument();
  });
});

// Contract: aria-selected reflects activeId.
describe("TabBar selection", () => {
  it("active tab has aria-selected", () => {
    setup(1);
    expect(screen.getByRole("tab", { name: "alpha" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "beta" })).toHaveAttribute("aria-selected", "false");
  });

  it("no tab is selected when activeId is null", () => {
    setup(null);
    const states = screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"));
    expect(states).toEqual(["false", "false"]);
  });
});

// Contract: click handling for activate, close and plus.
describe("TabBar interaction", () => {
  it("click activates", async () => {
    const { user, onActivate, onClose } = setup();
    await user.click(screen.getByRole("tab", { name: "beta" }));
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("close button calls onClose and not onActivate", async () => {
    const { user, onActivate, onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Close beta" }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(2);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("plus calls onActivate(null)", async () => {
    const { user, onActivate } = setup();
    await user.click(screen.getByRole("button", { name: "Start screen" }));
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(null);
  });
});
