import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SplitHandle } from "./SplitHandle";

type Props = Partial<React.ComponentProps<typeof SplitHandle>>;

function renderHandle(props: Props = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(
    <SplitHandle
      label="Resize branches column"
      value={300}
      min={160}
      max={500}
      step={16}
      onChange={onChange}
      onReset={onReset}
      {...props}
    />,
  );
  const handle = screen.getByRole("separator");
  const setPointerCapture = vi.spyOn(handle, "setPointerCapture");
  const releasePointerCapture = vi.spyOn(handle, "releasePointerCapture");
  return { handle, onChange, onReset, setPointerCapture, releasePointerCapture };
}

// Contract: the handle is an accessible vertical separator exposing its value range.
describe("SplitHandle accessibility", () => {
  it("should render a separator named by its label", () => {
    renderHandle();
    expect(screen.getByRole("separator", { name: "Resize branches column" })).toBeInTheDocument();
  });

  it("should be vertical", () => {
    const { handle } = renderHandle();
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
  });

  it("should expose value, min and max through aria-value attributes", () => {
    const { handle } = renderHandle();
    expect([
      handle.getAttribute("aria-valuenow"),
      handle.getAttribute("aria-valuemin"),
      handle.getAttribute("aria-valuemax"),
    ]).toEqual(["300", "160", "500"]);
  });

  it("should be focusable", () => {
    const { handle } = renderHandle();
    expect(handle).toHaveAttribute("tabindex", "0");
  });

  it("should reflect a changed value in aria-valuenow", () => {
    const { rerender } = render(
      <SplitHandle
        label="L"
        value={200}
        min={160}
        max={500}
        step={16}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    rerender(
      <SplitHandle
        label="L"
        value={220}
        min={160}
        max={500}
        step={16}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "220");
  });
});

// Contract: ArrowLeft/ArrowRight step by KEY_STEP, Home/End jump to the bounds, all clamped.
describe("SplitHandle keyboard", () => {
  it("should widen by one step on ArrowRight", async () => {
    const { handle, onChange } = renderHandle();
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(300 + 16);
  });

  it("should narrow by one step on ArrowLeft", async () => {
    const { handle, onChange } = renderHandle();
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(300 - 16);
  });

  it("should jump to min on Home", async () => {
    const { handle, onChange } = renderHandle();
    handle.focus();
    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(160);
  });

  it("should jump to max on End", async () => {
    const { handle, onChange } = renderHandle();
    handle.focus();
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("should clamp ArrowRight at max", async () => {
    const { handle, onChange } = renderHandle({ value: 495 });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("should clamp ArrowLeft at min", async () => {
    const { handle, onChange } = renderHandle({ value: 165 });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(160);
  });

  it("should ignore other keys", async () => {
    const { handle, onChange } = renderHandle();
    handle.focus();
    await userEvent.keyboard("a{ArrowUp}{ArrowDown}{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("should step by the step prop", async () => {
    const { handle, onChange } = renderHandle({ step: 5 });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(305);
  });

  it("should do nothing on End when max is not finite", async () => {
    const { handle, onChange } = renderHandle({ max: Infinity });
    handle.focus();
    await userEvent.keyboard("{End}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("should still step with ArrowRight when max is not finite", async () => {
    const { handle, onChange } = renderHandle({ max: Infinity });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(316);
  });

  it("should omit aria-valuemax when max is not finite", () => {
    const { handle } = renderHandle({ max: Infinity });
    expect(handle).not.toHaveAttribute("aria-valuemax");
  });

  it("should prevent the default action of a handled key", () => {
    const { handle } = renderHandle();
    const notPrevented = fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(notPrevented).toBe(false);
  });

  it("should not prevent the default action of an ignored key", () => {
    const { handle } = renderHandle();
    const notPrevented = fireEvent.keyDown(handle, { key: "Tab" });
    expect(notPrevented).toBe(true);
  });
});

// Contract: dragging moves the value by the pointer delta, clamped to [min, max].
describe("SplitHandle pointer drag", () => {
  it("should report value plus the pointer delta while dragging", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(330);
  });

  it("should report a smaller value when dragging left", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 70, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(270);
  });

  it("should clamp to max when dragged past it", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("should clamp to min when dragged below it", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -900, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(160);
  });

  it("should measure the delta from the pointerdown position on every move", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 120, pointerId: 1 });
    expect(onChange.mock.calls).toEqual([[310], [320]]);
  });

  it("should capture the pointer on pointerdown", () => {
    const { handle, setPointerCapture } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
    expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("should hold pointer capture between pointerdown and pointerup", () => {
    const { handle } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
    expect(handle.hasPointerCapture(7)).toBe(true);
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 7 });
    expect(handle.hasPointerCapture(7)).toBe(false);
  });

  it("should release the pointer on pointerup", () => {
    const { handle, releasePointerCapture } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 7 });
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("should release the pointer on pointercancel", () => {
    const { handle, releasePointerCapture } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
    fireEvent.pointerCancel(handle, { pointerId: 7 });
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("should not release the pointer before pointerup", () => {
    const { handle, releasePointerCapture } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 120, pointerId: 7 });
    expect(releasePointerCapture).not.toHaveBeenCalled();
  });

  it("should stop reporting changes after pointerup", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("should stop reporting changes after pointercancel", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("should ignore pointermove without a prior pointerdown", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("should start a fresh drag from the new pointerdown after a completed one", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 510, pointerId: 2 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(310);
  });

  it("should not call onReset while dragging", () => {
    const { handle, onReset } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 130, pointerId: 1 });
    expect(onReset).not.toHaveBeenCalled();
  });
});

// Contract: double-click resets the column to its default width.
describe("SplitHandle reset", () => {
  it("should call onReset on double-click", () => {
    const { handle, onReset } = renderHandle();
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("should not call onChange on double-click", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.doubleClick(handle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("should not call onReset on a single click", () => {
    const { handle, onReset } = renderHandle();
    fireEvent.click(handle);
    expect(onReset).not.toHaveBeenCalled();
  });
});

// Coverage audit: pointer sequences and keyboard edges.
describe("SplitHandle pointer sequence edges", () => {
  it("should reset the drag origin on a second pointerdown without a pointerup", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 410, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(310);
  });

  it("should ignore a pointermove that follows pointerup even after an earlier drag moved", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 110, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("should report exactly min when a drag lands precisely on the minimum", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 360, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(160);
  });

  it("should report a zero-delta move as the current value", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(300);
  });

  it("should pass fractional pointer deltas through unrounded", () => {
    const { handle, onChange } = renderHandle();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100.5, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(300.5);
  });

  it("should start the next drag from the value prop current at pointerdown", () => {
    const onChange = vi.fn();
    const props = { label: "L", min: 160, max: 500, step: 16, onChange, onReset: vi.fn() };
    const { rerender } = render(<SplitHandle {...props} value={200} />);
    const handle = screen.getByRole("separator");
    rerender(<SplitHandle {...props} value={250} />);
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 10, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(260);
  });
});

describe("SplitHandle keyboard edges", () => {
  it("should still report min on ArrowLeft when the value is already at min", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = renderHandle({ value: 160 });
    handle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(160);
  });

  it("should still report max on ArrowRight when the value is already at max", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = renderHandle({ value: 500 });
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("should report min on Home when the value is already at min", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = renderHandle({ value: 160 });
    handle.focus();
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(160);
  });

  it("should report max on End when the value is already at max", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = renderHandle({ value: 500 });
    handle.focus();
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("should clamp to max when a step overshoots it", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = renderHandle({ value: 495 });
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("should ignore vertical arrow keys", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = renderHandle();
    handle.focus();
    await user.keyboard("{ArrowUp}{ArrowDown}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("should clamp to max when max is below min (min wins as the lower bound only)", async () => {
    // clamp is min(max, max(min, px)); with max < min the result is max. Pin the behaviour.
    const user = userEvent.setup();
    const { handle, onChange } = renderHandle({ value: 300, min: 400, max: 350 });
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(350);
  });
});

// Contract: side="after" resizes the column after the handle, so pointer dx and arrows invert.
describe("SplitHandle side after", () => {
  it("should report a smaller value when the pointer moves right", () => {
    const { handle, onChange } = renderHandle({ side: "after" });
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(270);
  });

  it("should report a larger value when the pointer moves left", () => {
    const { handle, onChange } = renderHandle({ side: "after" });
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 70, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(330);
  });

  it("should clamp an inverted drag to min", () => {
    const { handle, onChange } = renderHandle({ side: "after" });
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(160);
  });

  it("should clamp an inverted drag to max", () => {
    const { handle, onChange } = renderHandle({ side: "after" });
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -900, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("should narrow by one step on ArrowRight", async () => {
    const { handle, onChange } = renderHandle({ side: "after" });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(300 - 16);
  });

  it("should widen by one step on ArrowLeft", async () => {
    const { handle, onChange } = renderHandle({ side: "after" });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(300 + 16);
  });

  it("should still jump to min on Home", async () => {
    const { handle, onChange } = renderHandle({ side: "after" });
    handle.focus();
    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(160);
  });

  it("should still jump to max on End", async () => {
    const { handle, onChange } = renderHandle({ side: "after" });
    handle.focus();
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("should still call onReset on double-click", () => {
    const { handle, onReset } = renderHandle({ side: "after" });
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe("SplitHandle side before", () => {
  it("should behave as the default when side is before", () => {
    const { handle, onChange } = renderHandle({ side: "before" });
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(330);
  });

  it("should widen on ArrowRight when side is before", async () => {
    const { handle, onChange } = renderHandle({ side: "before" });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(316);
  });
});
