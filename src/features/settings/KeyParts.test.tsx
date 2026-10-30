import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeyParts } from "./KeyParts";

// Contract: a chord's parts as one <kbd> each, or Unbound.
describe("KeyParts", () => {
  it("renders one kbd per part", () => {
    const { container } = render(<KeyParts parts={["Ctrl", "Shift", "F"]} />);
    expect([...container.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual([
      "Ctrl",
      "Shift",
      "F",
    ]);
  });

  it("renders Unbound for null", () => {
    const { container } = render(<KeyParts parts={null} />);
    expect(container).toHaveTextContent(/^Unbound$/);
    expect(container.querySelector("kbd")).toBeNull();
  });
});
