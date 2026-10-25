import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { CloneSourceTabs, cloneSourceIds } from "./CloneSourceTabs";
import type { CloneSource } from "./CloneSourceTabs";

function renderTabs(selected: CloneSource = "url", disabled = false) {
  const onSelect = vi.fn();
  const accountTabRef = createRef<HTMLButtonElement>();
  render(
    <CloneSourceTabs
      idBase="b"
      selected={selected}
      onSelect={onSelect}
      disabled={disabled}
      accountTabRef={accountTabRef}
    />,
  );
  return { onSelect, accountTabRef };
}

const urlTab = () => screen.getByRole("tab", { name: "URL" });
const accountTab = () => screen.getByRole("tab", { name: "From account" });

// Contract: a controlled WAI-ARIA tab strip; the parent owns the selection and the panels.
describe("CloneSourceTabs", () => {
  it("should name the ids that tie each tab to its panel from the id base", () => {
    expect(cloneSourceIds("b", "url")).toEqual({ tab: "b-tab-url", panel: "b-panel-url" });
    expect(cloneSourceIds("b", "account")).toEqual({
      tab: "b-tab-account",
      panel: "b-panel-account",
    });
  });

  it("should render the tab and panel ids it was given", () => {
    renderTabs();
    expect(urlTab()).toHaveAttribute("id", "b-tab-url");
    expect(urlTab()).toHaveAttribute("aria-controls", "b-panel-url");
    expect(accountTab()).toHaveAttribute("id", "b-tab-account");
    expect(accountTab()).toHaveAttribute("aria-controls", "b-panel-account");
  });

  it("should hand the From account button to the parent through accountTabRef", () => {
    const { accountTabRef } = renderTabs();
    expect(accountTabRef.current).toBe(accountTab());
  });

  it("should report the clicked tab to onSelect", () => {
    const { onSelect } = renderTabs();
    fireEvent.click(accountTab());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("account");
  });

  it("should not change its own selection: it stays controlled", () => {
    renderTabs("url");
    fireEvent.click(accountTab());
    expect(urlTab()).toHaveAttribute("aria-selected", "true");
    expect(accountTab()).toHaveAttribute("aria-selected", "false");
  });

  it.each([
    ["url", "ArrowRight", "account"],
    ["url", "ArrowLeft", "account"],
    ["account", "ArrowRight", "url"],
    ["account", "ArrowLeft", "url"],
    ["account", "Home", "url"],
    ["url", "End", "account"],
    ["url", "Home", "url"],
    ["account", "End", "account"],
  ] as const)("should select %s -> %s on %s", (selected, key, expected) => {
    const { onSelect } = renderTabs(selected);
    fireEvent.keyDown(selected === "url" ? urlTab() : accountTab(), { key });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("should focus the tab a key selects", () => {
    renderTabs("url");
    fireEvent.keyDown(urlTab(), { key: "ArrowRight" });
    expect(accountTab()).toHaveFocus();
  });

  it("should ignore keys that are not navigation keys", () => {
    const { onSelect } = renderTabs();
    fireEvent.keyDown(urlTab(), { key: "Tab" });
    fireEvent.keyDown(urlTab(), { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("should disable both tabs and select nothing on click while disabled", () => {
    const { onSelect } = renderTabs("url", true);
    expect(urlTab()).toBeDisabled();
    expect(accountTab()).toBeDisabled();
    fireEvent.click(accountTab());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
