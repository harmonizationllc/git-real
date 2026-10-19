import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ref } from "../../test/graphFixtures";
import { RefLabels } from "./RefLabels";

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
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByTitle("c")).toBeInTheDocument();
  });

  it("should title the +1 pill with the fourth label's name", () => {
    render(<RefLabels refs={four} />);
    expect(screen.getByText("+1")).toHaveAttribute("title", "the-fourth");
  });

  it("should not render the fourth label as its own pill", () => {
    render(<RefLabels refs={four} />);
    expect(screen.queryByText("the-fourth")).toBeNull();
  });

  it("should count every hidden label in the +n pill", () => {
    render(<RefLabels refs={[...four, ref("tag", "fifth")]} />);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("should list every hidden name in the +n title", () => {
    render(<RefLabels refs={[...four, ref("tag", "fifth")]} />);
    const title = screen.getByText("+2").getAttribute("title") ?? "";
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
    expect(screen.getByText("+1").className).toMatch(/pill/);
  });

  it("should declare the pill rule non-shrinking", () => {
    expect(rule(".pill")).toMatch(/flex(-shrink)?:\s*(none|0)\b/);
  });
});
