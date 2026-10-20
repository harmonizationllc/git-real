import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RebaseStepRow } from "./RebaseStepRow";
import type { RebaseStepRowProps } from "./RebaseStepRow";
import type { PlanStep } from "./model/plan";

const oid = "abcdef0123456789abcdef0123456789abcdef01";
const step = (over: Partial<PlanStep> = {}): PlanStep => ({
  oid,
  subject: "Add the thing",
  author: { name: "Ann", email: "ann@example.com", time: 1 },
  action: "pick",
  ...over,
});

function renderRow(over: Partial<RebaseStepRowProps> = {}) {
  const props: RebaseStepRowProps = {
    step: step(),
    index: 1,
    count: 3,
    blocked: false,
    disabled: false,
    dragging: false,
    dropTarget: false,
    onAction: vi.fn(),
    onMove: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    ...over,
  };
  render(
    <ol>
      <RebaseStepRow {...props} />
    </ol>,
  );
  return props;
}

const row = () => screen.getByRole("listitem");
const select = () => screen.getByRole("combobox", { name: "Action for abcdef0" });
const up = () => screen.getByRole("button", { name: "Move up" });
const down = () => screen.getByRole("button", { name: "Move down" });
const fakeTransfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });

// Contract: the row shows the commit and offers the five actions.
describe("RebaseStepRow content", () => {
  it("should show the short oid", () => {
    renderRow();
    expect(screen.getByText("abcdef0")).toBeInTheDocument();
  });

  it("should show the subject", () => {
    renderRow();
    expect(screen.getByText("Add the thing")).toBeInTheDocument();
  });

  it("should carry the full subject in the title", () => {
    renderRow({ step: step({ subject: "A very long subject line" }) });
    expect(screen.getByText("A very long subject line")).toHaveAttribute(
      "title",
      "A very long subject line",
    );
  });

  it("should show the author name", () => {
    renderRow();
    expect(screen.getByText("Ann")).toBeInTheDocument();
  });

  it("should label the select with the short oid", () => {
    renderRow();
    expect(select()).toBeInTheDocument();
  });

  it("should offer the five actions in order", () => {
    renderRow();
    expect(
      within(select())
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["pick", "squash", "fixup", "edit", "drop"]);
  });

  it("should offer the spec label for the first action", () => {
    renderRow();
    expect(within(select()).getAllByRole("option")[0]).toHaveTextContent("Pick — keep the commit");
  });

  it("should select the step's current action", () => {
    renderRow({ step: step({ action: "fixup" }) });
    expect(select()).toHaveValue("fixup");
  });

  it("should hide the drag handle from assistive technology", () => {
    renderRow();
    expect(screen.getByText("⋮⋮")).toHaveAttribute("aria-hidden", "true");
  });
});

// Contract: changing the select reports the new action.
describe("RebaseStepRow action select", () => {
  it("should call onAction with the chosen action", async () => {
    const props = renderRow();
    await userEvent.selectOptions(select(), "squash");
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith("squash");
  });

  it("should call onAction with drop when drop is chosen", async () => {
    const props = renderRow();
    await userEvent.selectOptions(select(), "drop");
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith("drop");
  });
});

// Contract: Move up / Move down report index -/+ 1 and are disabled at the ends.
describe("RebaseStepRow move buttons", () => {
  it("should call onMove with index - 1 for Move up", async () => {
    const props = renderRow({ index: 1 });
    await userEvent.click(up());
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("should call onMove with index + 1 for Move down", async () => {
    const props = renderRow({ index: 1 });
    await userEvent.click(down());
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("should disable Move up on the first row", () => {
    renderRow({ index: 0 });
    expect(up()).toBeDisabled();
  });

  it("should keep Move down enabled on the first row", () => {
    renderRow({ index: 0 });
    expect(down()).toBeEnabled();
  });

  it("should disable Move down on the last row", () => {
    renderRow({ index: 2, count: 3 });
    expect(down()).toBeDisabled();
  });

  it("should keep Move up enabled on the last row", () => {
    renderRow({ index: 2, count: 3 });
    expect(up()).toBeEnabled();
  });

  it("should enable both buttons on a middle row", () => {
    renderRow({ index: 1, count: 3 });
    expect([up(), down()].map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false]);
  });

  it("should disable both buttons on a single-row plan", () => {
    renderRow({ index: 0, count: 1 });
    expect([up(), down()].map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, true]);
  });
});

// Contract: a blocked fold shows an alert under the select.
describe("RebaseStepRow blocked fold", () => {
  it("should show the alert when blocked", () => {
    renderRow({ blocked: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot squash the oldest commit");
  });

  it("should show no alert when not blocked", () => {
    renderRow({ blocked: false });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// Contract: data attributes mark dropped rows, folding rows, and drag state.
describe("RebaseStepRow state attributes", () => {
  it("should mark a dropped step", () => {
    renderRow({ step: step({ action: "drop" }) });
    expect(row()).toHaveAttribute("data-dropped", "true");
  });

  it("should not mark a picked step as dropped", () => {
    renderRow({ step: step({ action: "pick" }) });
    expect(row()).not.toHaveAttribute("data-dropped");
  });

  it("should mark a squash step as folding", () => {
    renderRow({ step: step({ action: "squash" }) });
    expect(row()).toHaveAttribute("data-fold", "true");
  });

  it("should mark a fixup step as folding", () => {
    renderRow({ step: step({ action: "fixup" }) });
    expect(row()).toHaveAttribute("data-fold", "true");
  });

  it.each(["pick", "edit", "drop"] as const)("should not mark a %s step as folding", (action) => {
    renderRow({ step: step({ action }) });
    expect(row()).not.toHaveAttribute("data-fold");
  });

  it("should set data-dragging when dragging", () => {
    renderRow({ dragging: true });
    expect(row()).toHaveAttribute("data-dragging", "true");
  });

  it("should omit data-dragging when not dragging", () => {
    renderRow({ dragging: false });
    expect(row()).not.toHaveAttribute("data-dragging");
  });

  it("should set data-drop-target when it is the drop target", () => {
    renderRow({ dropTarget: true });
    expect(row()).toHaveAttribute("data-drop-target", "true");
  });

  it("should omit data-drop-target when it is not the drop target", () => {
    renderRow({ dropTarget: false });
    expect(row()).not.toHaveAttribute("data-drop-target");
  });
});

// Contract: an enabled row is draggable and reports drag events; the drag starts in WebKit
// only because dragstart sets data on the transfer.
describe("RebaseStepRow drag", () => {
  it("should be draggable when enabled", () => {
    renderRow();
    expect(row()).toHaveAttribute("draggable", "true");
  });

  it("should call onDragStart on dragstart", () => {
    const props = renderRow();
    fireEvent.dragStart(row(), { dataTransfer: fakeTransfer() });
    expect(props.onDragStart).toHaveBeenCalledOnce();
  });

  it("should set effectAllowed to move on dragstart", () => {
    renderRow();
    const dataTransfer = fakeTransfer();
    fireEvent.dragStart(row(), { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("should put the step oid on the transfer as text/plain on dragstart", () => {
    renderRow();
    const dataTransfer = fakeTransfer();
    fireEvent.dragStart(row(), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledExactlyOnceWith("text/plain", oid);
  });

  it("should call onDragOver on dragover", () => {
    const props = renderRow();
    fireEvent.dragOver(row(), { dataTransfer: fakeTransfer() });
    expect(props.onDragOver).toHaveBeenCalledOnce();
  });

  it("should prevent the default on dragover so the row accepts a drop", () => {
    renderRow();
    expect(fireEvent.dragOver(row(), { dataTransfer: fakeTransfer() })).toBe(false);
  });

  it("should set dropEffect to move on dragover", () => {
    renderRow();
    const dataTransfer = fakeTransfer();
    fireEvent.dragOver(row(), { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("move");
  });

  it("should call onDrop on drop", () => {
    const props = renderRow();
    fireEvent.drop(row());
    expect(props.onDrop).toHaveBeenCalledOnce();
  });

  it("should prevent the default on drop", () => {
    renderRow();
    expect(fireEvent.drop(row())).toBe(false);
  });
});

// Contract: a disabled (pending) row cannot be changed, moved or dragged.
describe("RebaseStepRow disabled", () => {
  it("should disable the select", () => {
    renderRow({ disabled: true });
    expect(select()).toBeDisabled();
  });

  it("should disable both move buttons on a middle row", () => {
    renderRow({ disabled: true, index: 1, count: 3 });
    expect([up(), down()].map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, true]);
  });

  it("should not be draggable", () => {
    renderRow({ disabled: true });
    expect(row()).not.toHaveAttribute("draggable", "true");
  });

  it("should not call onDragStart on dragstart", () => {
    const props = renderRow({ disabled: true });
    fireEvent.dragStart(row(), { dataTransfer: fakeTransfer() });
    expect(props.onDragStart).not.toHaveBeenCalled();
  });

  it("should not touch the transfer on dragstart", () => {
    renderRow({ disabled: true });
    const dataTransfer = fakeTransfer();
    fireEvent.dragStart(row(), { dataTransfer });
    expect([dataTransfer.setData.mock.calls.length, dataTransfer.effectAllowed]).toEqual([0, ""]);
  });

  it("should not call onDragOver on dragover", () => {
    const props = renderRow({ disabled: true });
    fireEvent.dragOver(row(), { dataTransfer: fakeTransfer() });
    expect(props.onDragOver).not.toHaveBeenCalled();
  });

  it("should not set dropEffect on dragover", () => {
    renderRow({ disabled: true });
    const dataTransfer = fakeTransfer();
    fireEvent.dragOver(row(), { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("");
  });

  it("should not call onDrop on drop", () => {
    const props = renderRow({ disabled: true });
    fireEvent.drop(row());
    expect(props.onDrop).not.toHaveBeenCalled();
  });
});
