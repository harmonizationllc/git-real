import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ContextMenu, type MenuItem } from "./ContextMenu";

function makeItems(overrides: Partial<MenuItem>[] = []): MenuItem[] {
  const base: MenuItem[] = [
    { id: "a", label: "Alpha", onSelect: vi.fn() },
    { id: "b", label: "Bravo", onSelect: vi.fn() },
    { id: "c", label: "Charlie", onSelect: vi.fn() },
  ];
  return base.map((item, i) => ({ ...item, ...overrides[i] }));
}

function renderMenu(items: MenuItem[], onClose = vi.fn(), open = true) {
  render(<ContextMenu open={open} x={10} y={20} items={items} onClose={onClose} />);
  return onClose;
}

// Contract: nothing is rendered while closed; when open it is an ARIA menu of menuitems.
describe("ContextMenu rendering", () => {
  it("should render nothing when closed", () => {
    renderMenu(makeItems(), vi.fn(), false);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should render a menu when open", () => {
    renderMenu(makeItems());
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("should render one menuitem per item", () => {
    renderMenu(makeItems());
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("should label each menuitem with its label in order", () => {
    renderMenu(makeItems());
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("should render an empty menu when there are no items", () => {
    renderMenu([]);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });
});

// Contract: the menu is positioned fixed at the given viewport coordinates.
describe("ContextMenu positioning", () => {
  it("should be positioned fixed at the given x and y when open", () => {
    renderMenu(makeItems());
    expect(screen.getByRole("menu")).toHaveStyle({
      position: "fixed",
      left: "10px",
      top: "20px",
    });
  });
});

// Contract: the first item receives focus on open.
describe("ContextMenu initial focus", () => {
  it("should focus the first item when opened", () => {
    renderMenu(makeItems());
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });
});

// Contract: ArrowDown/ArrowUp move focus between items and wrap at the ends.
describe("ContextMenu arrow navigation", () => {
  it("should focus the second item when ArrowDown is pressed once", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Bravo" })).toHaveFocus();
  });

  it("should wrap to the first item when ArrowDown is pressed on the last item", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems());
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });

  it("should wrap to the last item when ArrowUp is pressed on the first item", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems());
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Charlie" })).toHaveFocus();
  });

  it("should focus the previous item when ArrowUp is pressed on the second item", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems());
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });

  it("should not close the menu when arrow keys are pressed", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(makeItems());
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: Enter and Space select the focused item, then close the menu.
describe("ContextMenu keyboard selection", () => {
  it("should call onSelect of the focused item when Enter is pressed", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    renderMenu(items);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(items[1]?.onSelect).toHaveBeenCalledOnce();
  });

  it("should call onClose when Enter is pressed", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(makeItems());
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should call onSelect of the focused item when Space is pressed", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    renderMenu(items);
    await user.keyboard(" ");
    expect(items[0]?.onSelect).toHaveBeenCalledOnce();
  });

  it("should call onClose when Space is pressed", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(makeItems());
    await user.keyboard(" ");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should not call onSelect of other items when Enter is pressed", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    renderMenu(items);
    await user.keyboard("{Enter}");
    expect(items[1]?.onSelect).not.toHaveBeenCalled();
  });

  it("should call onSelect before onClose when Enter is pressed", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const items = makeItems([{ onSelect: () => order.push("select") }]);
    renderMenu(
      items,
      vi.fn(() => order.push("close")),
    );
    await user.keyboard("{Enter}");
    expect(order).toEqual(["select", "close"]);
  });
});

// Contract: Escape and mousedown outside close the menu; mousedown inside does not.
describe("ContextMenu dismissal", () => {
  it("should call onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(makeItems());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should not call onSelect when Escape is pressed", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    renderMenu(items);
    await user.keyboard("{Escape}");
    expect(items[0]?.onSelect).not.toHaveBeenCalled();
  });

  it("should call onClose when mousedown happens outside the menu", () => {
    const onClose = renderMenu(makeItems());
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should not call onClose when mousedown happens inside the menu", () => {
    const onClose = renderMenu(makeItems());
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should not call onClose when mousedown happens on a menuitem", () => {
    const onClose = renderMenu(makeItems());
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Bravo" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should not call onClose on outside mousedown or Escape when closed", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(makeItems(), vi.fn(), false);
    fireEvent.mouseDown(document.body);
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: clicking an item selects it and closes the menu.
describe("ContextMenu click selection", () => {
  it("should call onSelect of the clicked item", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    renderMenu(items);
    await user.click(screen.getByRole("menuitem", { name: "Charlie" }));
    expect(items[2]?.onSelect).toHaveBeenCalledOnce();
  });

  it("should call onClose after an item is clicked", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(makeItems());
    await user.click(screen.getByRole("menuitem", { name: "Bravo" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should not call onSelect of other items when one is clicked", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    renderMenu(items);
    await user.click(screen.getByRole("menuitem", { name: "Bravo" }));
    expect(items[0]?.onSelect).not.toHaveBeenCalled();
  });
});

// Contract: disabled items use native disabled and cannot be selected.
describe("ContextMenu disabled items", () => {
  it("should render a disabled item as natively disabled", () => {
    renderMenu(makeItems([{}, { disabled: true }]));
    expect(screen.getByRole("menuitem", { name: "Bravo" })).toBeDisabled();
  });

  it("should not render an enabled item as disabled", () => {
    renderMenu(makeItems([{}, { disabled: true }]));
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toBeEnabled();
  });

  it("should not call onSelect when a disabled item is clicked", async () => {
    const user = userEvent.setup();
    const items = makeItems([{}, { disabled: true }]);
    renderMenu(items);
    await user.click(screen.getByRole("menuitem", { name: "Bravo" }));
    expect(items[1]?.onSelect).not.toHaveBeenCalled();
  });

  it("should not call onClose when a disabled item is clicked", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(makeItems([{}, { disabled: true }]));
    await user.click(screen.getByRole("menuitem", { name: "Bravo" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: focus starts on the first enabled item, or on the menu when none is enabled.
describe("ContextMenu focus with disabled items", () => {
  it("should focus the first enabled item when the first item is disabled", () => {
    renderMenu(makeItems([{ disabled: true }]));
    expect(screen.getByRole("menuitem", { name: "Bravo" })).toHaveFocus();
  });

  it("should focus the menu itself when every item is disabled", () => {
    renderMenu(makeItems([{ disabled: true }, { disabled: true }, { disabled: true }]));
    expect(screen.getByRole("menu")).toHaveFocus();
  });

  it("should keep focus on the menu when ArrowDown is pressed and every item is disabled", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems([{ disabled: true }, { disabled: true }, { disabled: true }]));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toHaveFocus();
  });

  it("should focus the last enabled item when ArrowUp is pressed with focus on the menu container", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems());
    screen.getByRole("menu").focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Charlie" })).toHaveFocus();
  });

  it("should skip a disabled item when ArrowDown is pressed", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems([{}, { disabled: true }]));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Charlie" })).toHaveFocus();
  });

  it("should skip a disabled item when ArrowUp is pressed", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems([{}, { disabled: true }]));
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });

  it("should wrap past a disabled last item when ArrowDown is pressed", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems([{}, {}, { disabled: true }]));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });
});

// Contract: Home/End jump to the first/last enabled item.
describe("ContextMenu Home and End", () => {
  it("should focus the last enabled item when End is pressed", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems([{}, {}, { disabled: true }]));
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Bravo" })).toHaveFocus();
  });

  it("should focus the first enabled item when Home is pressed", async () => {
    const user = userEvent.setup();
    renderMenu(makeItems([{ disabled: true }]));
    await user.keyboard("{End}{Home}");
    expect(screen.getByRole("menuitem", { name: "Bravo" })).toHaveFocus();
  });
});

// Contract: Tab closes the menu; the menu suppresses the native context menu.
describe("ContextMenu Tab and contextmenu", () => {
  it("should call onClose when Tab is pressed", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(makeItems());
    await user.keyboard("{Tab}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should move focus to the next tab stop after the opener when Tab closes the menu", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Opener</button>
          <ContextMenu open={open} x={1} y={1} items={makeItems()} onClose={() => setOpen(false)} />
          <button>After</button>
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    await user.keyboard("{Tab}");
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  it("should prevent the native context menu when right-clicked", () => {
    renderMenu(makeItems());
    expect(fireEvent.contextMenu(screen.getByRole("menu"))).toBe(false);
  });
});

// Contract: the document mousedown listener and focus are cleaned up when the menu closes.
describe("ContextMenu lifecycle", () => {
  function renderWithOpener(open: boolean, onClose = vi.fn()) {
    const ui = (isOpen: boolean) => (
      <>
        <button>Opener</button>
        <ContextMenu open={isOpen} x={10} y={20} items={makeItems()} onClose={onClose} />
      </>
    );
    const view = render(ui(open));
    return { view, ui, onClose };
  }

  it("should not call onClose for an outside mousedown after the menu closes", () => {
    const { view, ui, onClose } = renderWithOpener(true);
    view.rerender(ui(false));
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should restore focus to the previously focused element when the menu closes", () => {
    const { view, ui } = renderWithOpener(false);
    screen.getByRole("button", { name: "Opener" }).focus();
    view.rerender(ui(true));
    view.rerender(ui(false));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });

  it("should render nothing but the opener when closed", () => {
    renderWithOpener(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

// Contract: the menu is clamped to stay inside the viewport (no flipping).
describe("ContextMenu viewport clamp", () => {
  function mockRect() {
    window.innerWidth = 1024;
    window.innerHeight = 768;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 100,
    } as DOMRect);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should shift the menu left and up when it would overflow the viewport", () => {
    mockRect();
    render(<ContextMenu open x={1000} y={750} items={makeItems()} onClose={vi.fn()} />);
    expect(screen.getByRole("menu")).toHaveStyle({ left: "824px", top: "668px" });
  });

  it("should clamp negative coordinates to zero", () => {
    mockRect();
    render(<ContextMenu open x={-5} y={-5} items={makeItems()} onClose={vi.fn()} />);
    expect(screen.getByRole("menu")).toHaveStyle({ left: "0px", top: "0px" });
  });

  it("should leave coordinates unchanged when the menu fits", () => {
    mockRect();
    render(<ContextMenu open x={40} y={60} items={makeItems()} onClose={vi.fn()} />);
    expect(screen.getByRole("menu")).toHaveStyle({ left: "40px", top: "60px" });
  });
});

// Contract: danger items carry a styling hook attribute; others do not.
describe("ContextMenu danger items", () => {
  it("should mark a danger item with data-danger true", () => {
    renderMenu(makeItems([{}, { danger: true }]));
    expect(screen.getByRole("menuitem", { name: "Bravo" })).toHaveAttribute("data-danger", "true");
  });

  it("should not mark a non-danger item with data-danger", () => {
    renderMenu(makeItems([{}, { danger: true }]));
    expect(screen.getByRole("menuitem", { name: "Alpha" })).not.toHaveAttribute("data-danger");
  });
});

// Contract: re-rendering an open menu with new props must not steal, lose or re-capture focus.
describe("ContextMenu re-render while open", () => {
  function ui(open: boolean, items: MenuItem[], onClose = vi.fn()) {
    return (
      <>
        <button>Opener</button>
        <ContextMenu open={open} x={10} y={20} items={items} onClose={onClose} />
      </>
    );
  }

  it("should keep focus on the focused item when re-rendered with new items", async () => {
    const user = userEvent.setup();
    const view = render(ui(true, makeItems()));
    await user.keyboard("{ArrowDown}");
    view.rerender(ui(true, makeItems()));
    expect(screen.getByRole("menuitem", { name: "Bravo" })).toHaveFocus();
  });

  it("should restore focus to the original opener, not an element inside the menu, after a re-render", async () => {
    const user = userEvent.setup();
    const view = render(ui(false, makeItems()));
    screen.getByRole("button", { name: "Opener" }).focus();
    view.rerender(ui(true, makeItems()));
    await user.keyboard("{ArrowDown}");
    view.rerender(ui(true, makeItems([{ label: "Renamed" }])));
    view.rerender(ui(false, makeItems()));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });
});

// Contract: exactly one document mousedown listener exists while open, none after close.
describe("ContextMenu document listener", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function netMouseDownListeners(add: MockInstance, remove: MockInstance) {
    const count = (spy: MockInstance) =>
      spy.mock.calls.filter((args: unknown[]) => args[0] === "mousedown").length;
    return count(add) - count(remove);
  }

  it("should keep a single mousedown listener across re-renders with new onClose callbacks", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const ui = (onClose: () => void) => (
      <ContextMenu open x={10} y={20} items={makeItems()} onClose={onClose} />
    );
    const view = render(ui(vi.fn()));
    view.rerender(ui(vi.fn()));
    view.rerender(ui(vi.fn()));
    expect(netMouseDownListeners(add, remove)).toBe(1);
  });

  it("should remove the mousedown listener when the menu closes", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const ui = (open: boolean) => (
      <ContextMenu open={open} x={10} y={20} items={makeItems()} onClose={vi.fn()} />
    );
    const view = render(ui(true));
    view.rerender(ui(false));
    expect(netMouseDownListeners(add, remove)).toBe(0);
  });

  it("should call only the latest onClose, once, on an outside mousedown after re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const ui = (onClose: () => void) => (
      <ContextMenu open x={10} y={20} items={makeItems()} onClose={onClose} />
    );
    const view = render(ui(first));
    view.rerender(ui(second));
    fireEvent.mouseDown(document.body);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
  });
});

// Contract: degenerate menus (one item, all disabled) behave predictably.
describe("ContextMenu degenerate menus", () => {
  it("should stay on the only item when ArrowDown is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu
        open
        x={0}
        y={0}
        items={[{ id: "only", label: "Only", onSelect: vi.fn() }]}
        onClose={vi.fn()}
      />,
    );
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Only" })).toHaveFocus();
  });

  it("should stay on the only item when ArrowUp is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu
        open
        x={0}
        y={0}
        items={[{ id: "only", label: "Only", onSelect: vi.fn() }]}
        onClose={vi.fn()}
      />,
    );
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Only" })).toHaveFocus();
  });

  it("should do nothing when Enter is pressed and every item is disabled", async () => {
    const user = userEvent.setup();
    const items = makeItems([{ disabled: true }, { disabled: true }, { disabled: true }]);
    const onClose = renderMenu(items);
    await user.keyboard("{Enter}");
    expect([
      items.map((i) => (i.onSelect as ReturnType<typeof vi.fn>).mock.calls.length),
      onClose.mock.calls.length,
    ]).toEqual([[0, 0, 0], 0]);
  });

  it("should close on Escape when every item is disabled", async () => {
    const user = userEvent.setup();
    const onClose = renderMenu(
      makeItems([{ disabled: true }, { disabled: true }, { disabled: true }]),
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should close on an outside mousedown when a disabled item exists", () => {
    const onClose = renderMenu(makeItems([{ disabled: true }]));
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should not close on a mousedown on a disabled item", () => {
    const onClose = renderMenu(makeItems([{ disabled: true }]));
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Alpha" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: a menu larger than the viewport pins to the top-left corner, never negative.
describe("ContextMenu oversized clamp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should never position the menu at a negative left or top when larger than the viewport", () => {
    window.innerWidth = 1024;
    window.innerHeight = 768;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 2000,
      height: 1500,
    } as DOMRect);
    render(<ContextMenu open x={300} y={400} items={makeItems()} onClose={vi.fn()} />);
    expect(screen.getByRole("menu")).toHaveStyle({ left: "0px", top: "0px" });
  });
});

// Contract: React StrictMode (double-invoked effects) must not double-fire callbacks or break focus.
describe("ContextMenu under StrictMode", () => {
  function renderStrict(items: MenuItem[], onClose = vi.fn()) {
    render(
      <StrictMode>
        <button>Opener</button>
        <ContextMenu open x={10} y={20} items={items} onClose={onClose} />
      </StrictMode>,
    );
    return onClose;
  }

  it("should call onClose once on an outside mousedown", () => {
    const onClose = renderStrict(makeItems());
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should call onSelect and onClose once each when an item is clicked", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    const onClose = renderStrict(items);
    await user.click(screen.getByRole("menuitem", { name: "Bravo" }));
    expect(
      [items[1]?.onSelect, onClose].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls.length),
    ).toEqual([1, 1]);
  });

  it("should focus the first item on open", () => {
    renderStrict(makeItems());
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });
});
