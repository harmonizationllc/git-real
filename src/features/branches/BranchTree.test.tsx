import { cleanup, render, screen, within, renderHook, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { declarationsOf } from "../../test/cssRules";
import { buildBranchTree } from "./branchTree";
import { BranchTreeItems, useCollapsedFolders } from "./BranchTree";

const names = ["feature/ui/toolbar", "feature/fix-1", "main"];
const nodes = buildBranchTree(names.map((name) => ({ name })));
const renderBranch = (b: { name: string }) => <li key={b.name}>{b.name}</li>;

function renderTree(collapsed: Set<string> = new Set(), onToggle = vi.fn(), keyPrefix?: string) {
  render(
    <ul aria-label="Local branches">
      <BranchTreeItems
        nodes={nodes}
        collapsed={collapsed}
        onToggle={onToggle}
        keyPrefix={keyPrefix}
        renderBranch={renderBranch}
      />
    </ul>,
  );
  return onToggle;
}

describe("BranchTreeItems", () => {
  it("should render folders as expanded buttons with nested labelled lists, folders first", () => {
    renderTree();
    const feature = screen.getByRole("button", { name: "feature" });
    expect(feature).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "feature branches" });
    expect(within(list).getByRole("list", { name: "feature/ui branches" })).toHaveTextContent(
      "feature/ui/toolbar",
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent?.slice(0, 7));
    expect(items[0]).toBe("feature"); // the folder item comes before main
    expect(screen.getByRole("list", { name: "Local branches" }).lastElementChild).toHaveTextContent(
      "main",
    );
  });

  it("should hide a collapsed folder's contents and report the click with the folder key", async () => {
    const onToggle = renderTree(new Set(["feature"]));
    const feature = screen.getByRole("button", { name: "feature" });
    expect(feature).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "feature branches" })).toBeNull();
    expect(screen.queryByText("feature/fix-1")).toBeNull();
    await userEvent.click(feature);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("feature");
  });

  it("should prefix folder keys so the same path under two remotes stays independent", async () => {
    const onToggle = renderTree(new Set(["upstream/feature"]), vi.fn(), "origin:");
    expect(screen.getByRole("button", { name: "feature" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "ui" }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("origin:feature/ui");
  });

  it("should keep a nested folder's own state when its parent is collapsed then expanded", () => {
    const { rerender } = render(
      <ul>
        <BranchTreeItems
          nodes={nodes}
          collapsed={new Set(["feature", "feature/ui"])}
          onToggle={vi.fn()}
          renderBranch={renderBranch}
        />
      </ul>,
    );
    rerender(
      <ul>
        <BranchTreeItems
          nodes={nodes}
          collapsed={new Set(["feature/ui"])}
          onToggle={vi.fn()}
          renderBranch={renderBranch}
        />
      </ul>,
    );
    expect(screen.getByRole("button", { name: "ui" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("feature/fix-1")).toBeInTheDocument();
  });

  it("should indent nested lists and use no disclosure glyph pseudo-elements", () => {
    const css = readFileSync("src/features/branches/BranchTree.module.css", "utf8");
    expect(declarationsOf(css, "children")).toContain("padding-left: var(--space-4)");
    expect(css).not.toMatch(/\.folder::before/);
    expect(css).not.toMatch(/\.folder\[aria-expanded="true"\]::before/);
  });

  it("should show the same decorative folder icon on expanded and collapsed folders", () => {
    renderTree();
    const open = screen.getByRole("button", { name: "feature" });
    const openIcon = open.querySelector("svg");
    expect(openIcon).toHaveAttribute("aria-hidden", "true");
    expect(open.textContent?.trim()).toBe("feature");
    cleanup();
    renderTree(new Set(["feature"]));
    const closed = screen.getByRole("button", { name: "feature" });
    expect(closed).toHaveAttribute("aria-expanded", "false");
    expect(closed.querySelector("svg")?.outerHTML).toBe(openIcon?.outerHTML);
    expect(closed.textContent?.trim()).toBe("feature");
  });

  it("should truncate long folder names with an ellipsis like branch names", () => {
    const css = readFileSync("src/features/branches/BranchTree.module.css", "utf8");
    const decls = declarationsOf(css, "folderName");
    expect(decls).toContain("text-overflow: ellipsis");
    expect(decls).toContain("white-space: nowrap");
  });
});

describe("useCollapsedFolders", () => {
  it("should start empty and toggle keys in and out without touching other keys", () => {
    const { result } = renderHook(() => useCollapsedFolders());
    expect(result.current.collapsed.size).toBe(0);
    act(() => result.current.toggle("feature"));
    act(() => result.current.toggle("feature/ui"));
    act(() => result.current.toggle("feature"));
    expect([...result.current.collapsed]).toEqual(["feature/ui"]);
  });
});
