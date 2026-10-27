import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "../../test/graphFixtures";
import { RefLabels } from "./RefLabels";

// The +N pill is found by its class, not by its text: its text content carries an sr-only suffix.
const morePill = () => document.querySelector('[class*="more"]') as HTMLElement;

// Contract: no labels renders nothing.
describe("RefLabels empty", () => {
  it("should render nothing for an empty list", () => {
    const { container } = render(<RefLabels refs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// Contract: a pill per label whose title is the full name and whose class names its kind.
describe("RefLabels pills", () => {
  it("should render a pill showing each label name", () => {
    render(<RefLabels refs={[ref("branch", "main"), ref("tag", "v1.0")]} />);
    expect(screen.getByTitle("main")).toHaveTextContent("main");
    expect(screen.getByTitle("v1.0")).toHaveTextContent("v1.0");
  });

  it("should give a branch pill the branch class", () => {
    render(<RefLabels refs={[ref("branch", "feature")]} />);
    expect(screen.getByTitle("feature").className).toMatch(/branch/);
  });

  it("should give a remote pill the remote class", () => {
    render(<RefLabels refs={[ref("remote", "origin/main")]} />);
    expect(screen.getByTitle("origin/main").className).toMatch(/remote/);
  });

  it("should give a tag pill the tag class", () => {
    render(<RefLabels refs={[ref("tag", "v1.0")]} />);
    expect(screen.getByTitle("v1.0").className).toMatch(/tag/);
  });

  it("should give a detached HEAD pill the head class", () => {
    render(<RefLabels refs={[ref("head", "HEAD", true)]} />);
    expect(screen.getByTitle("HEAD").className).toMatch(/head/);
  });

  it("should not give a tag pill the branch class", () => {
    render(<RefLabels refs={[ref("tag", "v1.0")]} />);
    expect(screen.getByTitle("v1.0").className).not.toMatch(/branch/);
  });

  it("should use the full name as the title of a long label", () => {
    render(<RefLabels refs={[ref("remote", "origin/feature/very-long-name")]} />);
    expect(screen.getByTitle("origin/feature/very-long-name")).toBeInTheDocument();
  });
});

// Contract: the HEAD branch pill is emphasised and marked current.
describe("RefLabels HEAD branch", () => {
  it("should give the HEAD branch pill the head class", () => {
    render(<RefLabels refs={[ref("branch", "main", true)]} />);
    expect(screen.getByTitle("main").className).toMatch(/head/);
  });

  it('should mark the HEAD branch pill with aria-current="true"', () => {
    render(<RefLabels refs={[ref("branch", "main", true)]} />);
    expect(screen.getByTitle("main")).toHaveAttribute("aria-current", "true");
  });

  it("should not mark another branch pill as current", () => {
    render(<RefLabels refs={[ref("branch", "main", true), ref("branch", "dev")]} />);
    expect(screen.getByTitle("dev")).not.toHaveAttribute("aria-current");
  });

  it("should not give a non-HEAD branch pill the head class", () => {
    render(<RefLabels refs={[ref("branch", "dev")]} />);
    expect(screen.getByTitle("dev").className).not.toMatch(/head/);
  });
});

// Contract: at most MAX_LABELS pills, the rest collapse into a +n pill titled with their names.
describe("RefLabels overflow", () => {
  const four = [ref("branch", "a"), ref("branch", "b"), ref("tag", "c"), ref("tag", "the-fourth")];

  it("should show three pills and a +1 pill for four labels", () => {
    render(<RefLabels refs={four} />);
    expect(morePill()).toBeInTheDocument();
    expect(screen.getByTitle("c")).toBeInTheDocument();
  });

  it("should title the +1 pill with the fourth label's name", () => {
    render(<RefLabels refs={four} />);
    expect(morePill()).toHaveAttribute("title", "the-fourth");
  });

  it("should not render the fourth label as its own pill", () => {
    render(<RefLabels refs={four} />);
    expect(screen.queryByText("the-fourth")).toBeNull();
  });

  it("should count every hidden label in the +n pill", () => {
    render(<RefLabels refs={[...four, ref("tag", "fifth")]} />);
    expect(morePill()).toBeInTheDocument();
  });

  it("should list every hidden name in the +n title", () => {
    render(<RefLabels refs={[...four, ref("tag", "fifth")]} />);
    const title = morePill().getAttribute("title") ?? "";
    expect(title).toContain("the-fourth");
    expect(title).toContain("fifth");
  });

  it("should not render a +n pill for exactly three labels", () => {
    render(<RefLabels refs={four.slice(0, 3)} />);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it("should not render a +n pill for a single label", () => {
    render(<RefLabels refs={[ref("branch", "main")]} />);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });
});

// Contract: pills never shrink, so a narrow centre column clips the strip instead of collapsing a pill.
describe("RefLabels pill sizing", () => {
  const css = readFileSync("src/features/graph/RefLabels.module.css", "utf8");
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("should give every pill, including +n, the shared pill class", () => {
    render(
      <RefLabels
        refs={[ref("remote", "origin/main"), ref("tag", "a"), ref("tag", "b"), ref("tag", "c")]}
      />,
    );
    for (const title of ["origin/main", "a"]) {
      expect(screen.getByTitle(title).className).toMatch(/pill/);
    }
    expect(morePill().className).toMatch(/pill/);
  });

  it("should declare the pill rule non-shrinking", () => {
    expect(rule(".pill")).toMatch(/flex:\s*none/);
  });

  it("should cap a pill at 24ch", () => {
    expect(rule(".pill")).toMatch(/max-width:\s*24ch/);
  });

  it("should not declare gap in CSS; the gaps are inline from layout constants", () => {
    expect(rule(".root")).not.toMatch(/gap:/);
  });

  it("should give the root an inline 4px gap", () => {
    const { container } = render(<RefLabels refs={[ref("branch", "a")]} />);
    expect((container.firstElementChild as HTMLElement).style.gap).toBe("4px");
  });

  it("should declare an sr-only rule for the +n suffix", () => {
    expect(rule(".srOnly")).toMatch(/position:\s*absolute/);
    expect(rule(".srOnly")).toMatch(/clip:/);
  });

  it("should position the root so hidden pills cannot widen an ancestor", () => {
    expect(rule(".root")).toMatch(/position:\s*relative/);
  });
});

// Contract: pills are measured against the parent cell; trailing pills that do not fit are hidden and counted into +N.
// Measurement stub: the component must read `parentElement.clientWidth` and each pill's `offsetWidth`.
describe("RefLabels fit", () => {
  // Keyed on the element's first text node, so a nested sr-only span in the +N pill is ignored.
  const widths: Record<string, number> = { a: 40, b: 80, c: 40 };
  let cellWidth = 0;
  let observers: StubResizeObserver[] = [];

  class StubResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(public callback: ResizeObserverCallback) {
      observers.push(this);
    }
    fire() {
      this.callback([], this as unknown as ResizeObserver);
    }
  }

  beforeEach(() => {
    observers = [];
    cellWidth = 0;
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        const first = this.firstChild;
        return first?.nodeType === Node.TEXT_NODE ? (widths[first.textContent ?? ""] ?? 0) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === "cell" ? cellWidth : 0;
      },
    });
  });

  afterEach(() => {
    delete widths["+2"];
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  const three = [ref("branch", "a"), ref("branch", "b"), ref("tag", "c")];
  const renderInCell = (refs = three) =>
    render(
      <span data-testid="cell">
        <RefLabels refs={refs} />
      </span>,
    );

  it("should observe its parent cell", () => {
    cellWidth = 200;
    renderInCell();
    const observed = observers.flatMap((o) => o.observe.mock.calls.map((c) => c[0]));
    expect(observed).toContain(screen.getByTestId("cell"));
  });

  it("should show every pill while unmeasured", () => {
    renderInCell();
    for (const name of ["a", "b", "c"]) {
      expect(screen.getByTitle(name)).not.toHaveAttribute("data-hidden");
    }
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it("should hide trailing pills that do not fit and count them into +N", () => {
    // budget = 200 - 64 - 6 = 130; three = 168 > 130; two + more = 164 > 130; so one.
    cellWidth = 200;
    renderInCell();
    expect(screen.getByTitle("a")).not.toHaveAttribute("data-hidden");
    expect(screen.getByTitle("b")).toHaveAttribute("data-hidden", "true");
    expect(screen.getByTitle("c")).toHaveAttribute("data-hidden", "true");
    const more = morePill();
    expect(more).not.toHaveAttribute("aria-label");
    expect(more).toHaveAccessibleName("+2 more: b, c");
    expect(more.firstChild?.textContent).toBe("+2");
    expect(more).toHaveAttribute("title", "b\nc");
  });

  it("should re-measure when a candidate name changes at the same count", () => {
    cellWidth = 200;
    const { rerender } = renderInCell();
    expect(morePill()).toBeInTheDocument();
    // d has no entry in the width table, so it measures 0 (unmeasured): every candidate shows.
    rerender(
      <span data-testid="cell">
        <RefLabels refs={[ref("branch", "a"), ref("branch", "b"), ref("tag", "d")]} />
      </span>,
    );
    for (const name of ["a", "b", "d"]) {
      expect(screen.getByTitle(name)).not.toHaveAttribute("data-hidden");
    }
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it("should keep a hidden pill's full name as its title", () => {
    cellWidth = 200;
    renderInCell();
    expect(screen.getByTitle("b")).toHaveTextContent("b");
  });

  it("should count labels beyond MAX_LABELS and labels that do not fit together", () => {
    // budget = 235 - 64 - 6 = 165; three = 160 + 8 = 168 > 165; two + more = 40+80+36 + 8 = 164 fits -> 2.
    // Hidden: c (does not fit) and d (beyond MAX_LABELS) -> +2.
    cellWidth = 235;
    renderInCell([...three, ref("tag", "d")]);
    expect(screen.getByTitle("c")).toHaveAttribute("data-hidden", "true");
    expect(morePill()).toHaveAccessibleName("+2 more: c, d");
  });

  it("should re-measure when the observer fires", () => {
    renderInCell();
    expect(screen.getByTitle("b")).not.toHaveAttribute("data-hidden");
    cellWidth = 200;
    act(() => observers.forEach((o) => o.fire()));
    expect(screen.getByTitle("b")).toHaveAttribute("data-hidden", "true");
  });

  it("should use the +N pill's measured width when it has one", () => {
    // budget = 240 - 64 - 6 = 170; with the pill at 60, k=2 needs 40+80+60+8 = 188 > 170, so k=1.
    widths["+2"] = 60;
    cellWidth = 240;
    renderInCell();
    expect(screen.getByTitle("a")).not.toHaveAttribute("data-hidden");
    expect(screen.getByTitle("b")).toHaveAttribute("data-hidden", "true");
    expect(screen.getByTitle("c")).toHaveAttribute("data-hidden", "true");
    expect(morePill().firstChild?.textContent).toBe("+2");
  });

  it("should show exactly three refs that all fit with no +N pill", () => {
    // budget = 240 - 64 - 6 = 170; 40 + 80 + 40 + 8 = 168 fits.
    cellWidth = 240;
    renderInCell();
    for (const name of ["a", "b", "c"]) {
      expect(screen.getByTitle(name)).not.toHaveAttribute("data-hidden");
    }
    expect(morePill()).toBeNull();
  });

  it("should disconnect on unmount", () => {
    cellWidth = 200;
    const { unmount } = renderInCell();
    unmount();
    expect(observers.some((o) => o.disconnect.mock.calls.length > 0)).toBe(true);
  });
});
