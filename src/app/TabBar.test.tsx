import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../lib/ipc";
import type { RepoTab } from "../lib/store/repoTabs";
import { useShell } from "../lib/store/shell";
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

beforeEach(async () => {
  useShell.setState({ dialog: null, repoActions: null });
  vi.mocked(updateSettings).mockReset();
  await resetSettings();
});

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
