// Task 13: Failing tests for TextSetting component.
// These tests import modules/symbols that do not exist yet — red phase.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextSetting } from "./TextSetting";

// Contract: TextSetting renders a labelled input and commits on blur or Enter.
function setup(
  value: string | null = "initial",
  onCommit: (next: string | null) => Promise<string | null> = vi.fn().mockResolvedValue(null),
) {
  render(
    <TextSetting
      id="test-setting"
      label="My Setting"
      value={value}
      onCommit={onCommit}
      hint="A helpful hint"
    />,
  );
  const input = screen.getByRole("textbox", { name: "My Setting" });
  return { input, onCommit };
}

// Contract: commits on blur and on Enter when the value has changed.
describe("TextSetting commit behaviour", () => {
  it("commits on blur when changed", async () => {
    const onCommit = vi.fn().mockResolvedValue(null);
    const { input } = setup("initial", onCommit);
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("changed");
  });

  it("commits on Enter when changed", async () => {
    const onCommit = vi.fn().mockResolvedValue(null);
    const { input } = setup("initial", onCommit);
    fireEvent.change(input, { target: { value: "new value" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("new value");
  });

  it("does not commit an unchanged value on blur", () => {
    const onCommit = vi.fn().mockResolvedValue(null);
    const { input } = setup("initial", onCommit);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit an unchanged value on Enter", () => {
    const onCommit = vi.fn().mockResolvedValue(null);
    const { input } = setup("initial", onCommit);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("maps an empty value to null on commit", async () => {
    const onCommit = vi.fn().mockResolvedValue(null);
    const { input } = setup("initial", onCommit);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(null);
  });
});

// Contract: inline error from onCommit keeps the typed text after Enter; reverts after blur.
describe("TextSetting error handling", () => {
  it("shows the inline error and keeps the text after Enter", async () => {
    const onCommit = vi.fn().mockResolvedValue("Not a Git executable: exited with code 1");
    const { input } = setup("initial", onCommit);
    fireEvent.change(input, { target: { value: "/usr/bin/false" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Not a Git executable: exited with code 1");
    expect(input).toHaveValue("/usr/bin/false");
  });

  it("shows the inline error and reverts to the stored value after blur", async () => {
    const onCommit = vi.fn().mockResolvedValue("Not a Git executable: exited with code 1");
    const { input } = setup("initial", onCommit);
    fireEvent.change(input, { target: { value: "/usr/bin/false" } });
    fireEvent.blur(input);
    await screen.findByText("Not a Git executable: exited with code 1");
    expect(input).toHaveValue("initial");
  });
});

// Contract: resets the draft to the new value after a successful commit.
describe("TextSetting value update", () => {
  it("resets the draft to the new value after a successful commit", async () => {
    const onCommit = vi.fn().mockResolvedValue(null);
    const { input } = setup("initial", onCommit);
    fireEvent.change(input, { target: { value: "saved" } });
    fireEvent.blur(input);
    // After commit resolves, the value should reflect the committed state.
    await new Promise((r) => setTimeout(r, 0));
    expect(input).toHaveValue("saved");
  });
});
