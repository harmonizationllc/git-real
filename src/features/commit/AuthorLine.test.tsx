import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthorLine } from "./AuthorLine";

describe("AuthorLine", () => {
  it("shows name and email", () => {
    render(<AuthorLine config={{ name: "Ada", email: "ada@x.org", signing: null }} />);
    expect(screen.getByText("Ada <ada@x.org>")).toBeInTheDocument();
    expect(screen.queryByText(/Signs with/)).toBeNull();
  });

  it("shows the fallback when name or email is missing", () => {
    render(<AuthorLine config={{ name: "Ada", email: null, signing: null }} />);
    expect(screen.getByText("Author not configured")).toBeInTheDocument();
  });

  it("shows nothing identifying while config is loading", () => {
    render(<AuthorLine config={undefined} />);
    expect(screen.queryByText("Author not configured")).toBeNull();
    expect(screen.queryByText(/</)).toBeNull();
  });

  it.each([
    ["openPgp", "Signs with GPG"],
    ["ssh", "Signs with SSH"],
    ["x509", "Signs with X.509"],
  ] as const)("shows the %s signing badge", (signing, label) => {
    render(<AuthorLine config={{ name: "Ada", email: "a@b.c", signing }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
