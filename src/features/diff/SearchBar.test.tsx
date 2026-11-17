import { createRef, type Ref } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/renderWithProviders";
import { SearchBar, type SearchBarProps } from "./SearchBar";

function setup(over: Partial<SearchBarProps> = {}, ref?: Ref<HTMLInputElement>) {
  const props: SearchBarProps = {
    query: "foo",
    wholeWord: false,
    matchCase: false,
    current: 0,
    total: 3,
    capped: false,
    onQueryChange: vi.fn(),
    onToggleWholeWord: vi.fn(),
    onToggleMatchCase: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  const view = renderWithProviders(<SearchBar {...props} ref={ref} />);
  return { props, ...view };
}

describe("SearchBar", () => {
  it("renders the field, counter, arrows, toggles and close in order", () => {
    const { container } = setup();
    const bar = container.querySelector('[role="search"]')!;
    expect(bar).toHaveAttribute("aria-label", "Find in diff");
    const order = [...bar.querySelectorAll("input, [aria-live], button")].map(
      (el) =>
        el.getAttribute("aria-label") ?? (el.hasAttribute("aria-live") ? "counter" : el.tagName),
    );
    expect(order).toEqual([
      "Find",
      "counter",
      "Previous match",
      "Next match",
      "Match whole word",
      "Match case",
      "Close",
    ]);
  });

  it("hides the counter for an empty query and shows 0/0 with the no-results state when nothing matches", () => {
    const empty = setup({ query: "", total: 0, current: null });
    expect(empty.container.querySelector("[aria-live]")).toBeEmptyDOMElement();
    expect(empty.getByRole("textbox", { name: "Find" })).not.toHaveAttribute("data-state");
    empty.unmount();

    const none = setup({ query: "zzz", total: 0, current: null });
    expect(none.container.querySelector("[aria-live]")).toHaveTextContent("0/0");
    expect(none.getByRole("textbox", { name: "Find" })).toHaveAttribute("data-state", "no-results");
  });

  it("shows current+1/total, and total+ when capped", () => {
    const view = setup({ current: 1, total: 3 });
    expect(view.container.querySelector("[aria-live]")).toHaveTextContent("2/3");
    view.rerender(
      <SearchBar {...view.props} current={0} total={20000} capped onQueryChange={vi.fn()} />,
    );
    expect(view.container.querySelector("[aria-live]")).toHaveTextContent("1/20000+");
  });

  it("disables the arrows when total is 0", () => {
    const { getByRole } = setup({ total: 0, current: null });
    expect(getByRole("button", { name: "Previous match" })).toBeDisabled();
    expect(getByRole("button", { name: "Next match" })).toBeDisabled();
  });

  it("reflects and toggles aria-pressed on whole word and match case", async () => {
    const { getByRole, props, user } = setup({ wholeWord: true });
    const word = getByRole("button", { name: "Match whole word" });
    const matchCase = getByRole("button", { name: "Match case" });
    expect(word).toHaveAttribute("aria-pressed", "true");
    expect(matchCase).toHaveAttribute("aria-pressed", "false");
    await user.click(word);
    await user.click(matchCase);
    expect(props.onToggleWholeWord).toHaveBeenCalledTimes(1);
    expect(props.onToggleMatchCase).toHaveBeenCalledTimes(1);
  });

  it("Enter calls onNext, Shift+Enter onPrev, Escape onClose, and each stops propagation", async () => {
    const { getByRole, props, user } = setup();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    const field = getByRole("textbox", { name: "Find" });
    field.focus();
    await user.keyboard("{Enter}");
    expect(props.onNext).toHaveBeenCalledTimes(1);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(props.onPrev).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onNext).toHaveBeenCalledTimes(1);
    // React stops the native event at its root, so no outer listener sees these keys.
    const seen = outer.mock.calls.map(([e]) => (e as KeyboardEvent).key);
    expect(seen).not.toContain("Enter");
    expect(seen).not.toContain("Escape");
    document.removeEventListener("keydown", outer);
  });

  it("forwards the ref to the input", () => {
    const ref = createRef<HTMLInputElement>();
    const { getByRole } = setup({}, ref);
    expect(ref.current).toBe(getByRole("textbox", { name: "Find" }));
  });

  it("reports typed text through onQueryChange", async () => {
    const { getByRole, props, user } = setup({ query: "" });
    await user.type(getByRole("textbox", { name: "Find" }), "a");
    expect(props.onQueryChange).toHaveBeenCalledWith("a");
  });
});
