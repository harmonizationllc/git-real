import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { declarationsOf } from "../../test/cssRules";
import { oidOf } from "../../test/graphFixtures";
import { tagEntry } from "../../test/tagFixtures";
import type { TagEntry } from "../../lib/ipc";
import { fullDate } from "../graph/model/relativeTime";
import { TagRow } from "./TagRow";

const onSelect = vi.fn();
const onContextMenu = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
});

function renderRow(tag: TagEntry = tagEntry("v1")) {
  render(
    <ul>
      <TagRow tag={tag} onSelect={onSelect} onContextMenu={onContextMenu} />
    </ul>,
  );
  return { button: screen.getByRole("button"), item: screen.getByRole("listitem") };
}

// Contract: name, short target and an annotated marker carrying the subject.
describe("TagRow content", () => {
  it("shows the name and the short target with no marker for a lightweight tag", () => {
    const { item } = renderRow(tagEntry("v1", { target: oidOf(4) }));
    expect(within(item).getByText("v1")).toBeInTheDocument();
    expect(within(item).getByText(oidOf(4).slice(0, 7))).toBeInTheDocument();
    expect(within(item).queryByText("annotated")).toBeNull();
  });

  it("shows an annotated marker whose title is the subject", () => {
    renderRow(tagEntry("v1", { annotated: true, subject: "Release 1" }));
    expect(screen.getByText("annotated")).toHaveAttribute("title", "Release 1");
  });

  it("shows an annotated marker without a title when there is no subject", () => {
    renderRow(tagEntry("v1", { annotated: true, subject: null }));
    expect(screen.getByText("annotated")).not.toHaveAttribute("title");
  });

  it("titles the button with the full date of the tag", () => {
    const { button } = renderRow(tagEntry("v1", { time: 1_700_000_000 }));
    expect(button).toHaveAttribute("title", fullDate(1_700_000_000));
  });
});

// Contract: a slashed name shows its last segment and keeps the full name for assistive tech.
describe("TagRow folder names", () => {
  it("shows the last segment aria-hidden and keeps the full accessible name", () => {
    const { button } = renderRow(tagEntry("release/v1.0"));
    expect(within(button).getByText("v1.0")).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAccessibleName(/^release\/v1\.0/);
  });

  it("shows an unslashed name exactly once", () => {
    renderRow(tagEntry("v2"));
    expect(screen.getAllByText("v2")).toHaveLength(1);
  });

  it("positions the row and reuses the shared sr-only rule", () => {
    const css = readFileSync("src/features/tags/TagRow.module.css", "utf8");
    expect(declarationsOf(css, "row")).toMatch(/position:\s*relative/);
    expect(declarationsOf(css, "srOnly")).toMatch(
      /composes:\s*srOnly from "\.\.\/branches\/BranchRow\.module\.css"/,
    );
  });
});

// Contract: click, Enter and Space select the target commit.
describe("TagRow selection", () => {
  it("click calls onSelect", async () => {
    const { button } = renderRow();
    await userEvent.setup().click(button);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("Enter and Space call onSelect", async () => {
    const { button } = renderRow();
    const user = userEvent.setup();
    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("does not call onContextMenu on a plain click", async () => {
    const { button } = renderRow();
    await userEvent.setup().click(button);
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});

// Contract: right-click and the keyboard open the context menu and suppress the native one.
describe("TagRow context menu", () => {
  it("right-click calls onContextMenu with the pointer position", () => {
    const { button } = renderRow();
    fireEvent.contextMenu(button, { clientX: 10, clientY: 20 });
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(10, 20);
  });

  it("right-click prevents the native menu", () => {
    const { button } = renderRow();
    expect(fireEvent.contextMenu(button, { clientX: 1, clientY: 2 })).toBe(false);
  });

  it("Shift+F10 calls onContextMenu at the row's bottom-left and prevents the default", () => {
    const { button } = renderRow();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      left: 5,
      bottom: 30,
    } as DOMRect);
    expect(fireEvent.keyDown(button, { key: "F10", shiftKey: true })).toBe(false);
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(5, 30);
  });

  it("the ContextMenu key calls onContextMenu and prevents the default", () => {
    const { button } = renderRow();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      left: 5,
      bottom: 30,
    } as DOMRect);
    expect(fireEvent.keyDown(button, { key: "ContextMenu" })).toBe(false);
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(5, 30);
  });

  it("F10 without Shift does nothing", () => {
    const { button } = renderRow();
    fireEvent.keyDown(button, { key: "F10" });
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("other keys do nothing", () => {
    const { button } = renderRow();
    fireEvent.keyDown(button, { key: "a" });
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});
