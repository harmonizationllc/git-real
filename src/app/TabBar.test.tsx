import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../lib/ipc";
import type { RepoTab } from "../lib/store/repoTabs";
import { useShell } from "../lib/store/shell";
import { declarationsOf } from "../test/cssRules";
import { resetSettings, seedSettings } from "../test/settingsStore";
import { TabBar } from "./TabBar";

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const tab = (id: number, name: string): RepoTab => ({
  id,
  summary: { path: `/r/${name}`, name, headBranch: "main", isBare: false },
});
const tabs = [tab(1, "alpha"), tab(2, "beta")];
const threeTabs = [...tabs, tab(3, "gamma")];

beforeEach(async () => {
  useShell.setState({ dialog: null, repoActions: null });
  vi.mocked(updateSettings).mockReset();
  await resetSettings();
});

function setup(activeId: number | null = 1, list: RepoTab[] = tabs) {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onMove = vi.fn();
  const user = userEvent.setup();
  render(
    <TabBar
      tabs={list}
      activeId={activeId}
      onActivate={onActivate}
      onClose={onClose}
      onMove={onMove}
    />,
  );
  return { user, onActivate, onClose, onMove };
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

// Task 15: the two shell-dialog buttons land after the Start screen button.
describe("TabBar shell buttons (GR-14)", () => {
  it("renders Command palette and Settings buttons with their titles after Start screen", () => {
    setup();
    const palette = screen.getByRole("button", { name: "Command palette" });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(palette).toBeInTheDocument();
    expect(settings).toBeInTheDocument();
    expect(palette).toHaveAttribute("title", "Command palette (Ctrl+K)");
    expect(settings).toHaveAttribute("title", "Settings (Ctrl+,)");
  });

  it("the Command palette button opens the palette dialog on the shell store", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Command palette" }));
    expect(useShell.getState().dialog).toEqual({ kind: "palette" });
  });

  it("the Settings button opens the settings dialog on the shell store", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(useShell.getState().dialog).toMatchObject({ kind: "settings" });
  });
});

// Contract (GR-18): the shell button titles follow the effective bindings.
describe("TabBar shortcut titles", () => {
  it("titles follow the effective bindings", async () => {
    await seedSettings({ shortcuts: { bindings: { palette: "Mod+Alt+P", settings: null } } });
    setup();
    expect(screen.getByRole("button", { name: "Command palette" })).toHaveAttribute(
      "title",
      "Command palette (Ctrl+Alt+P)",
    );
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("title", "Settings");
  });
});

// Contract (GR-18b §3): the shell button titles show learned keycaps.
describe("TabBar learned keycaps", () => {
  it("titles use learned keycaps", async () => {
    await seedSettings({ shortcuts: { bindings: {}, keycaps: { K: "T" } } });
    setup();
    expect(screen.getByRole("button", { name: "Command palette" })).toHaveAttribute(
      "title",
      "Command palette (Ctrl+T)",
    );
  });
});

// Contract: the COSMIC look, pinned at the source: pill tabs, the active one on a card.
describe("TabBar styling", () => {
  const css = readFileSync("src/app/TabBar.module.css", "utf8");

  it("lays tabs out as pills with the active one on a card", () => {
    expect(declarationsOf(css, "tab")).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(declarationsOf(css, "active")).toMatch(/background:\s*var\(--color-surface\)/);
    expect(declarationsOf(css, "active")).toMatch(/box-shadow:\s*var\(--shadow-card\)/);
    expect(css).not.toMatch(/border-bottom/);
  });

  it("pads the bottom so overflow-x clipping spares focus rings, with a margin that keeps the gap", () => {
    const root = declarationsOf(css, "root");
    expect(root).toMatch(/padding:\s*var\(--space-2\) var\(--space-2\) var\(--space-1\)/);
    expect(root).toMatch(/margin-bottom:\s*calc\(-1 \* var\(--space-1\)\)/);
  });

  it("renders the add, palette, settings and close buttons as icon variants", () => {
    setup();
    for (const name of [/start screen/i, /command palette/i, /^settings$/i]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("data-variant", "icon");
    }
    const close = screen.getByRole("button", { name: /close alpha/i });
    expect(close).toHaveAttribute("data-variant", "icon");
    expect(close).toHaveAttribute("data-size", "sm");
  });
});

describe("TabBar new-tab button", () => {
  it("is the only filled icon button", () => {
    setup();
    expect(screen.getByRole("button", { name: "Start screen" })).toHaveAttribute(
      "data-fill",
      "neutral",
    );
    expect(screen.getByRole("button", { name: "Settings" })).not.toHaveAttribute("data-fill");
    expect(screen.getByRole("button", { name: "Command palette" })).not.toHaveAttribute(
      "data-fill",
    );
  });
});

const fakeTransfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
const MIME = "application/x-git-real-tab";

// Contract: tabs reorder by native drag and drop; only a drag that started on a tab counts.
describe("TabBar drag and drop", () => {
  const wrapper = (name: string) => screen.getByRole("tab", { name }).parentElement as HTMLElement;

  it("should make every tab draggable", () => {
    setup(1, threeTabs);
    for (const name of ["alpha", "beta", "gamma"]) {
      expect(wrapper(name)).toHaveAttribute("draggable", "true");
    }
  });

  it("should put the tab id on the transfer under the tab MIME type", () => {
    setup(1, threeTabs);
    const dataTransfer = fakeTransfer();
    fireEvent.dragStart(wrapper("alpha"), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(MIME, "1");
  });

  it("should move a dragged tab right to the drop position", () => {
    const { onMove } = setup(1, threeTabs);
    fireEvent.dragStart(wrapper("alpha"), { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(wrapper("gamma"), { dataTransfer: fakeTransfer() });
    fireEvent.drop(wrapper("gamma"));
    expect(onMove).toHaveBeenCalledExactlyOnceWith(1, 2);
  });

  it("should move a dragged tab left to the drop position", () => {
    const { onMove } = setup(1, threeTabs);
    fireEvent.dragStart(wrapper("gamma"), { dataTransfer: fakeTransfer() });
    fireEvent.drop(wrapper("alpha"));
    expect(onMove).toHaveBeenCalledExactlyOnceWith(3, 0);
  });

  it("should mark the dragged tab and the tab under the pointer", () => {
    setup(1, threeTabs);
    fireEvent.dragStart(wrapper("alpha"), { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(wrapper("gamma"), { dataTransfer: fakeTransfer() });
    expect(wrapper("alpha")).toHaveAttribute("data-dragging", "true");
    expect(wrapper("gamma")).toHaveAttribute("data-drop-target", "true");
  });

  it("should not activate or move when a tab is dropped on itself", () => {
    const { onMove, onActivate } = setup(1, threeTabs);
    fireEvent.dragStart(wrapper("alpha"), { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(wrapper("alpha"), { dataTransfer: fakeTransfer() });
    expect(wrapper("alpha")).not.toHaveAttribute("data-drop-target");
    fireEvent.drop(wrapper("alpha"));
    expect(onMove).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("should clear the markers when the drag ends without a drop", () => {
    const { onMove } = setup(1, threeTabs);
    fireEvent.dragStart(wrapper("alpha"), { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(wrapper("gamma"), { dataTransfer: fakeTransfer() });
    fireEvent.dragEnd(wrapper("alpha"));
    expect(document.querySelector("[data-dragging]")).toBeNull();
    expect(document.querySelector("[data-drop-target]")).toBeNull();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("should ignore a drag that did not start on a tab", () => {
    const { onMove } = setup(1, threeTabs);
    expect(fireEvent.dragOver(wrapper("beta"), { dataTransfer: fakeTransfer() })).toBe(true);
    fireEvent.drop(wrapper("beta"));
    expect(document.querySelector("[data-drop-target]")).toBeNull();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("should not activate a tab during a drag and drop", () => {
    const { onActivate } = setup(1, threeTabs);
    fireEvent.dragStart(wrapper("alpha"), { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(wrapper("gamma"), { dataTransfer: fakeTransfer() });
    fireEvent.drop(wrapper("gamma"));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("styles the dragged tab and the drop target", () => {
    const css = readFileSync("src/app/TabBar.module.css", "utf8");
    expect(css).toMatch(/\.tab\[data-dragging\]\s*\{[^}]*opacity:\s*0\.5/);
    expect(css).toMatch(
      /\.tab\[data-drop-target\]\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--color-accent\)/,
    );
    expect(declarationsOf(css, "tab")).toMatch(/opacity:\s*0\.5/);
  });
});
