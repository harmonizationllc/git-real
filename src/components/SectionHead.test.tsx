import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionHead, SectionHeadSlot } from "./SectionHead";

const slots: HTMLElement[] = [];

function makeSlot() {
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  slots.push(slot);
  return slot;
}

afterEach(() => {
  for (const slot of slots.splice(0)) slot.remove();
});

// Contract: the header band renders into the column's slot, or in place outside a column.
describe("SectionHead", () => {
  it("should render its children in place without a provider", () => {
    const { container } = render(
      <SectionHead>
        <button>Header</button>
      </SectionHead>,
    );
    expect(container).toContainElement(screen.getByRole("button", { name: "Header" }));
  });

  it("should render its children into the slot element and not in place", () => {
    const slot = makeSlot();
    const { container } = render(
      <SectionHeadSlot.Provider value={slot}>
        <SectionHead>
          <button>Header</button>
        </SectionHead>
      </SectionHeadSlot.Provider>,
    );
    const button = screen.getByRole("button", { name: "Header" });
    expect(slot).toContainElement(button);
    expect(container).not.toContainElement(button);
  });

  it("should render nothing while the slot has not mounted", () => {
    render(
      <SectionHeadSlot.Provider value={null}>
        <SectionHead>
          <button>Header</button>
        </SectionHead>
      </SectionHeadSlot.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Header" })).toBeNull();
  });

  it("should deliver a click in the slot to a React ancestor's onClick", () => {
    const slot = makeSlot();
    const onClick = vi.fn();
    render(
      <SectionHeadSlot.Provider value={slot}>
        <div onClick={onClick}>
          <SectionHead>
            <button>Header</button>
          </SectionHead>
        </div>
      </SectionHeadSlot.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Header" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
