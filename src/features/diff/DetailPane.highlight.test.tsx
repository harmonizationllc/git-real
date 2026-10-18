import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileDiff } from "../../lib/ipc";
import { useDiffPrefs } from "../../lib/store/diffPrefs";
import { useWorkspace } from "../../lib/store/workspace";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DetailPane } from "./DetailPane";

// Unlike DetailPane.test.tsx this file keeps the REAL useHighlight, so a wiring mistake between
// the hook, the pane and the viewer cannot hide behind a mock. Only IPC and the virtualizer
// (which needs layout) are faked.
vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFileDiff: vi.fn(),
}));
vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"));

const REPO = 1;
const lines = () => [
  L("context", "const keep = 1;", 1, 1),
  L("deletion", "const alpha = 'x';", 2, null),
  L("addition", "const beta = 'y';", null, 2),
];

const setup = (path: string) => {
  vi.mocked(getFileDiff).mockResolvedValue(fileDiff([hunk(lines())], { path }));
  useWorkspace.getState().select(REPO, { path, scope: "unstaged" });
  return renderWithProviders(<DetailPane repoId={REPO} />);
};

const tokens = (container: HTMLElement) => container.querySelectorAll("[class*='tok-']");

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspace.setState({ selected: {} });
  useDiffPrefs.setState({ mode: "split", ignoreWhitespace: false });
});

// Contract: a diff of a known language ends up with syntax token classes in the viewer.
describe("DetailPane with the real highlighter", () => {
  it("should eventually render token classes for a .ts file", async () => {
    const { container } = setup("a.ts");
    await screen.findByRole("region", { name: "Diff" });
    await waitFor(() => expect(tokens(container).length).toBeGreaterThan(0));
  });

  it("should tokenise the keyword of a line, not just decorate something else", async () => {
    setup("a.ts");
    await screen.findByRole("region", { name: "Diff" });
    await waitFor(() => expect(screen.getAllByText("const")[0].className).toMatch(/tok-keyword/));
  });

  it("should render the text of every line unchanged once highlighted", async () => {
    const { container } = setup("a.ts");
    await waitFor(() => expect(tokens(container).length).toBeGreaterThan(0));
    expect(container.textContent).toContain("const keep = 1;");
    expect(container.textContent).toContain("const alpha = 'x';");
    expect(container.textContent).toContain("const beta = 'y';");
  });

  it("should keep the highlight after switching to unified mode", async () => {
    const { container } = setup("a.ts");
    await waitFor(() => expect(tokens(container).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    await waitFor(() => expect(container.querySelector('[data-kind="empty"]')).toBeNull());
    expect(tokens(container).length).toBeGreaterThan(0);
    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });

  it("should render no token classes for a file type without a grammar", async () => {
    const { container } = setup("notes.unknownext");
    await screen.findByRole("region", { name: "Diff" });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(tokens(container)).toHaveLength(0);
  });

  it("should drop the previous file's tokens when another file is selected", async () => {
    const { container } = setup("a.ts");
    await waitFor(() => expect(tokens(container).length).toBeGreaterThan(0));
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([hunk(lines())], { path: "b.unknownext" }));
    act(() => useWorkspace.getState().select(REPO, { path: "b.unknownext", scope: "unstaged" }));
    await screen.findByRole("region", { name: "Diff" });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(tokens(container)).toHaveLength(0);
  });
});
