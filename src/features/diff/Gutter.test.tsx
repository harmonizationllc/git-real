import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Gutter } from "./Gutter";

// Contract: a gutter is a plain span showing the line number, never a control.
describe("Gutter", () => {
  it("should render the line number in a span", () => {
    const { container } = render(<Gutter lineno={42} />);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("42");
  });

  it("should render an empty span for a null line number", () => {
    const { container } = render(<Gutter lineno={null} />);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("");
  });

  it("should render no button", () => {
    render(<Gutter lineno={42} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should carry no aria-pressed", () => {
    const { container } = render(<Gutter lineno={42} />);
    expect(container.querySelector("[aria-pressed]")).toBeNull();
  });
});
