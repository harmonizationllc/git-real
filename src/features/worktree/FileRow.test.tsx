import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChangeKind, StatusEntry } from "../../lib/ipc";
import { FileRow, type FileRowProps, type Section } from "./FileRow";

const entry = (over: Partial<StatusEntry> = {}): StatusEntry => ({
  path: "src/a.txt",
  oldPath: null,
  index: null,
  worktree: "modified",
  conflicted: false,
  ...over,
});

function setup(over: Partial<FileRowProps> = {}) {
  const props: FileRowProps = {
    entry: entry(),
    section: "unstaged" as Section,
    kind: "modified" as ChangeKind,
    selected: false,
    disabled: false,
    onClick: vi.fn(),
    onContextMenu: vi.fn(),
    onPrimary: vi.fn(),
    ...over,
  };
  const view = render(
    <ul>
      <FileRow {...props} />
    </ul>,
  );
  return { props, ...view };
}

// Contract: the row button names the kind and the path.
describe("FileRow labels", () => {
  it("should name the row button with the kind words and the path", () => {
    setup();
    expect(screen.getByRole("button", { name: "modified src/a.txt" })).toBeInTheDocument();
  });

  it("should use the type change words in the row name", () => {
    setup({ kind: "typeChange" });
    expect(screen.getByRole("button", { name: "type change src/a.txt" })).toBeInTheDocument();
  });

  it("should show old and new paths when a renamed row has an old path", () => {
    setup({
      kind: "renamed",
      section: "staged",
      entry: entry({ path: "b.txt", oldPath: "a.txt", index: "renamed", worktree: null }),
    });
    expect(screen.getByRole("button", { name: "renamed a.txt → b.txt" })).toBeInTheDocument();
  });

  it("should show only the path when a renamed row has no old path", () => {
    setup({ kind: "renamed", entry: entry({ path: "b.txt", oldPath: null }) });
    expect(screen.getByRole("button", { name: "renamed b.txt" })).toBeInTheDocument();
  });

  it("should ignore the old path when the kind is not renamed", () => {
    setup({ entry: entry({ path: "b.txt", oldPath: "a.txt" }) });
    expect(screen.getByRole("button", { name: "modified b.txt" })).toBeInTheDocument();
  });

  it("should render a badge for the given kind", () => {
    setup({ kind: "untracked" });
    expect(screen.getByRole("img", { name: "untracked" })).toBeInTheDocument();
  });

  it("should mute the directory part when the path has a slash", () => {
    setup({ entry: entry({ path: "src/deep/a.txt" }) });
    expect(screen.getByText("src/deep/")).toBeInTheDocument();
  });

  it("should show the file name in its own element when the path has a slash", () => {
    setup({ entry: entry({ path: "src/deep/a.txt" }) });
    expect(screen.getByText("a.txt")).toBeInTheDocument();
  });

  it("should render no directory element when the path has no slash", () => {
    setup({ entry: entry({ path: "a.txt" }) });
    expect(screen.queryByText(/\/$/)).toBeNull();
  });
});

// Contract: the primary button stages or unstages by section; discard only when offered.
describe("FileRow action buttons", () => {
  it.each<[Section, string]>([
    ["unstaged", "Stage"],
    ["conflicts", "Stage"],
    ["staged", "Unstage"],
  ])("should label the primary button for the %s section", (section, label) => {
    setup({ section });
    expect(screen.getByRole("button", { name: `${label} src/a.txt` })).toHaveTextContent(
      new RegExp(`^${label}$`),
    );
  });

  it("should label the primary button with the raw path for a rename", () => {
    setup({ kind: "renamed", entry: entry({ path: "b.txt", oldPath: "a.txt" }) });
    expect(screen.getByRole("button", { name: "Stage b.txt" })).toBeInTheDocument();
  });

  it("should call onPrimary when the primary button is clicked", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Stage src/a.txt" }));
    expect(props.onPrimary).toHaveBeenCalledTimes(1);
  });

  it("should not call onClick when the primary button is clicked", () => {
    // Acting on a row must not be a selection click; the panel owns that distinction.
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Stage src/a.txt" }));
    expect(props.onClick).not.toHaveBeenCalled();
  });

  it("should render a discard button when onDiscard is provided", () => {
    setup({ onDiscard: vi.fn() });
    expect(screen.getByRole("button", { name: "Discard src/a.txt" })).toBeInTheDocument();
  });

  it("should not render a discard button when onDiscard is absent", () => {
    setup();
    expect(screen.queryByRole("button", { name: /^Discard/ })).toBeNull();
  });

  it("should call onDiscard when the discard button is clicked", () => {
    const onDiscard = vi.fn();
    setup({ onDiscard });
    fireEvent.click(screen.getByRole("button", { name: "Discard src/a.txt" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("should disable the primary button when disabled", () => {
    setup({ disabled: true });
    expect(screen.getByRole("button", { name: "Stage src/a.txt" })).toBeDisabled();
  });

  it("should disable the discard button when disabled", () => {
    setup({ disabled: true, onDiscard: vi.fn() });
    expect(screen.getByRole("button", { name: "Discard src/a.txt" })).toBeDisabled();
  });

  it("should keep the row button enabled when disabled", () => {
    setup({ disabled: true });
    expect(screen.getByRole("button", { name: "modified src/a.txt" })).toBeEnabled();
  });

  it("should enable the action buttons when not disabled", () => {
    setup({ onDiscard: vi.fn() });
    expect(screen.getByRole("button", { name: "Stage src/a.txt" })).toBeEnabled();
  });
});

// Contract: selection state and click modifiers.
describe("FileRow selection", () => {
  it("should set aria-pressed true when selected", () => {
    setup({ selected: true });
    expect(screen.getByRole("button", { name: "modified src/a.txt" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("should set aria-pressed false when not selected", () => {
    setup({ selected: false });
    expect(screen.getByRole("button", { name: "modified src/a.txt" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("should call onClick with no modifiers on a plain click", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "modified src/a.txt" }));
    expect(props.onClick).toHaveBeenCalledWith({ ctrlKey: false, metaKey: false, shiftKey: false });
  });

  it("should pass ctrlKey when clicked with ctrl", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "modified src/a.txt" }), { ctrlKey: true });
    expect(props.onClick).toHaveBeenCalledWith({ ctrlKey: true, metaKey: false, shiftKey: false });
  });

  it("should pass metaKey when clicked with meta", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "modified src/a.txt" }), { metaKey: true });
    expect(props.onClick).toHaveBeenCalledWith({ ctrlKey: false, metaKey: true, shiftKey: false });
  });

  it("should pass shiftKey when clicked with shift", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "modified src/a.txt" }), { shiftKey: true });
    expect(props.onClick).toHaveBeenCalledWith({ ctrlKey: false, metaKey: false, shiftKey: true });
  });
});

// Contract: right click reports the pointer position and suppresses the native menu.
describe("FileRow context menu", () => {
  it("should call onContextMenu with the pointer coordinates", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByRole("button", { name: "modified src/a.txt" }), {
      clientX: 40,
      clientY: 60,
    });
    expect(props.onContextMenu).toHaveBeenCalledWith(40, 60);
  });

  it("should prevent the native context menu", () => {
    setup();
    const notPrevented = fireEvent.contextMenu(
      screen.getByRole("button", { name: "modified src/a.txt" }),
      { clientX: 1, clientY: 2 },
    );
    expect(notPrevented).toBe(false);
  });

  it("should open the menu when an action button is right-clicked", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Stage src/a.txt" }), {
      clientX: 5,
      clientY: 6,
    });
    expect(props.onContextMenu).toHaveBeenCalledWith(5, 6);
  });
});
