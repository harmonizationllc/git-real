import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RecentEntry } from "../../lib/ipc";
import { RecentList } from "./RecentList";

const entry = (name: string, path = `/home/u/${name}`): RecentEntry => ({
  name,
  path,
  lastOpened: 1,
});

// Contract: one row per recent entry, with a row button that opens and a sibling remove button.
describe("RecentList rendering", () => {
  it("should render a row with name and path for each entry", () => {
    render(<RecentList recents={[entry("a"), entry("b")]} onOpen={vi.fn()} onRemove={vi.fn()} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[1]).getByRole("button", { name: "b /home/u/b" })).toBeInTheDocument();
  });

  it("should render an empty list when there are no entries", () => {
    render(<RecentList recents={[]} onOpen={vi.fn()} onRemove={vi.fn()} />);
    expect(within(screen.getByRole("list")).queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("RecentList open", () => {
  it("should call onOpen with the path when a row is clicked", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<RecentList recents={[entry("a"), entry("b")]} onOpen={onOpen} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "b /home/u/b" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("/home/u/b");
  });

  it("should call onOpen when the focused row is activated with Enter", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<RecentList recents={[entry("a")]} onOpen={onOpen} onRemove={vi.fn()} />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("/home/u/a");
  });
});

describe("RecentList remove", () => {
  it("should call onRemove with the path when the remove button is clicked", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<RecentList recents={[entry("b")]} onOpen={vi.fn()} onRemove={onRemove} />);
    await user.click(screen.getByRole("button", { name: "Remove b from recent repositories" }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("/home/u/b");
  });

  it("should not call onOpen when the remove button is clicked", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<RecentList recents={[entry("b")]} onOpen={onOpen} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remove b from recent repositories" }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
