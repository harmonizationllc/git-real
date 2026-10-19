import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBlame } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { oidOf, shortOf } from "../../test/graphFixtures";
import { blameHunk, blameOf } from "../../test/historyFixtures";
import { mockWindow } from "../../test/mockVirtualizer";
import { renderWithProviders } from "../../test/renderWithProviders";
import type { Token } from "../diff/model/highlight";
import { useTextHighlight } from "../diff/useTextHighlight";
import { fullDate } from "../graph/model/relativeTime";
import { BlameView } from "./BlameView";

vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getBlame: vi.fn(),
}));

vi.mock("../diff/useTextHighlight", () => ({ useTextHighlight: vi.fn() }));

const REPO = 1;
const PATH = "src/a.ts";
const LINES = ["const one = 1;", "const two = 2;", "const three = 3;"];
const A = oidOf(0);
const B = oidOf(1);

// Hunk A blames lines 1-2 (three hours ago, Alice); hunk B blames line 3 (Bob).
const hunks = () => {
  const now = Math.floor(Date.now() / 1000);
  return [
    blameHunk(0, 1, 2, {
      summary: "Add the constants",
      author: { name: "Alice", email: "alice@x.io", time: now - 3 * 3600 },
    }),
    blameHunk(1, 3, 1, {
      summary: "Add three",
      author: { name: "Bob", email: "bob@x.io", time: now - 2 * 86400 },
    }),
  ];
};

beforeEach(() => {
  vi.resetAllMocks();
  mockWindow.size = Infinity;
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  vi.mocked(getBlame).mockResolvedValue(blameOf(hunks(), LINES, PATH));
  vi.mocked(useTextHighlight).mockReturnValue(null);
});

async function renderBlame(oid: string | null = null) {
  const view = renderWithProviders(<BlameView repoId={REPO} path={PATH} oid={oid} />);
  await screen.findAllByRole("row");
  return view;
}

const table = () => screen.getByRole("table", { name: "Blame" });
const rowAt = (n: number) => screen.getAllByRole("row")[n] as HTMLElement;

// Contract: the data comes from getBlame for the path at the oid, or HEAD for null.
describe("BlameView data", () => {
  it("should blame HEAD when the oid is null", async () => {
    await renderBlame(null);
    expect(getBlame).toHaveBeenCalledExactlyOnceWith(REPO, PATH, null);
  });

  it("should blame at the given commit", async () => {
    await renderBlame(B);
    expect(getBlame).toHaveBeenCalledExactlyOnceWith(REPO, PATH, B);
  });

  it("should highlight the file's lines for its path", async () => {
    await renderBlame();
    expect(useTextHighlight).toHaveBeenLastCalledWith(PATH, LINES);
  });
});

// Contract: a valid ARIA table, one row per line, virtualized so it carries the total.
describe("BlameView table", () => {
  it("should render a table named Blame", async () => {
    await renderBlame();
    expect(table()).toBeInTheDocument();
  });

  it("should render one row per line", async () => {
    await renderBlame();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("should carry the row total in aria-rowcount", async () => {
    await renderBlame();
    expect(table()).toHaveAttribute("aria-rowcount", "3");
  });

  it("should number rows from 1 with aria-rowindex", async () => {
    await renderBlame();
    expect(screen.getAllByRole("row").map((r) => r.getAttribute("aria-rowindex"))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("should show each line's 1-based line number", async () => {
    await renderBlame();
    expect(within(rowAt(0)).getByText("1")).toBeInTheDocument();
    expect(within(rowAt(1)).getByText("2")).toBeInTheDocument();
    expect(within(rowAt(2)).getByText("3")).toBeInTheDocument();
  });

  it("should show each line's content", async () => {
    await renderBlame();
    expect(rowAt(0)).toHaveTextContent("const one = 1;");
    expect(rowAt(2)).toHaveTextContent("const three = 3;");
  });

  it("should render cells inside each row", async () => {
    await renderBlame();
    expect(within(rowAt(0)).getAllByRole("cell").length).toBeGreaterThan(0);
  });

  it("should render the table with no rows for an empty file", async () => {
    vi.mocked(getBlame).mockResolvedValue(blameOf([blameHunk(0, 1, 0)], [], PATH));
    renderWithProviders(<BlameView repoId={REPO} path={PATH} oid={null} />);
    await waitFor(() => expect(table()).toBeInTheDocument());
    expect(table()).toHaveAttribute("aria-rowcount", "0");
    expect(screen.queryAllByRole("row")).toEqual([]);
  });

  it("should not render rows past the lines for an over-long hunk", async () => {
    vi.mocked(getBlame).mockResolvedValue(blameOf([blameHunk(0, 1, 9)], ["one", "two"], PATH));
    renderWithProviders(<BlameView repoId={REPO} path={PATH} oid={null} />);
    expect(await screen.findAllByRole("row")).toHaveLength(2);
  });
});

// Contract: the hash button, author and date show on a hunk's first line only.
describe("BlameView hunk metadata", () => {
  it("should show a hash button on the first line of each hunk", async () => {
    await renderBlame();
    expect(within(rowAt(0)).getByRole("button")).toHaveTextContent(shortOf(A));
    expect(within(rowAt(2)).getByRole("button")).toHaveTextContent(shortOf(B));
  });

  it("should show no hash button on later lines of a hunk", async () => {
    await renderBlame();
    expect(within(rowAt(1)).queryByRole("button")).toBeNull();
  });

  it("should label the hash button Open commit with the seven-character hash", async () => {
    await renderBlame();
    expect(screen.getByRole("button", { name: `Open commit ${shortOf(A)}` })).toBeInTheDocument();
  });

  it("should title the hash button with the full oid and the summary", async () => {
    await renderBlame();
    expect(screen.getByRole("button", { name: `Open commit ${shortOf(A)}` })).toHaveAttribute(
      "title",
      `${A} Add the constants`,
    );
  });

  it("should select the commit when the hash button is clicked", async () => {
    await renderBlame();
    fireEvent.click(screen.getByRole("button", { name: `Open commit ${shortOf(B)}` }));
    expect(useWorkspace.getState().selectedCommit[REPO]).toBe(B);
  });

  it("should show the author on the first line of a hunk", async () => {
    await renderBlame();
    expect(within(rowAt(0)).getByText("Alice")).toBeInTheDocument();
    expect(within(rowAt(2)).getByText("Bob")).toBeInTheDocument();
  });

  it("should show no author on later lines of a hunk", async () => {
    await renderBlame();
    expect(within(rowAt(1)).queryByText("Alice")).toBeNull();
  });

  it("should show the relative date on the first line of a hunk", async () => {
    await renderBlame();
    expect(within(rowAt(0)).getByText("3 hours ago")).toBeInTheDocument();
    expect(within(rowAt(2)).getByText("2 days ago")).toBeInTheDocument();
  });

  it("should title the date with the full date", async () => {
    await renderBlame();
    const time = hunks()[0].author.time;
    expect(within(rowAt(0)).getByText("3 hours ago")).toHaveAttribute("title", fullDate(time));
  });

  it("should show no date on later lines of a hunk", async () => {
    await renderBlame();
    expect(within(rowAt(1)).queryByText("3 hours ago")).toBeNull();
  });
});

// Contract: hunks alternate a background and the selected commit's hunk is marked current.
describe("BlameView hunk marks", () => {
  it("should alternate data-hunk-parity by hunk position", async () => {
    await renderBlame();
    expect(screen.getAllByRole("row").map((r) => r.getAttribute("data-hunk-parity"))).toEqual([
      "0",
      "0",
      "1",
    ]);
  });

  it('should set data-current="true" on every row of the selected commit\'s hunk', async () => {
    useWorkspace.getState().selectCommit(REPO, A);
    await renderBlame();
    expect(rowAt(0)).toHaveAttribute("data-current", "true");
    expect(rowAt(1)).toHaveAttribute("data-current", "true");
  });

  it("should leave other hunks without data-current", async () => {
    useWorkspace.getState().selectCommit(REPO, A);
    await renderBlame();
    expect(rowAt(2)).not.toHaveAttribute("data-current");
  });

  it("should mark no row when no commit is selected", async () => {
    await renderBlame();
    expect(document.querySelector("[data-current]")).toBeNull();
  });

  it("should mark no row when the selected commit blames nothing here", async () => {
    useWorkspace.getState().selectCommit(REPO, oidOf(40));
    await renderBlame();
    expect(document.querySelector("[data-current]")).toBeNull();
  });

  it("should move the mark when another commit is selected", async () => {
    await renderBlame();
    fireEvent.click(screen.getByRole("button", { name: `Open commit ${shortOf(B)}` }));
    await waitFor(() => expect(rowAt(2)).toHaveAttribute("data-current", "true"));
    expect(rowAt(0)).not.toHaveAttribute("data-current");
  });
});

// Contract: tokens from useTextHighlight colour each line's content.
describe("BlameView highlighting", () => {
  it("should apply a line's tokens to its content", async () => {
    const tokens: (Token[] | null)[] = [
      [
        { text: "const", className: "tok-kw" },
        { text: " one = 1;", className: null },
      ],
      null,
      null,
    ];
    vi.mocked(useTextHighlight).mockReturnValue(tokens);
    await renderBlame();
    expect(within(rowAt(0)).getByText("const")).toHaveClass("tok-kw");
  });

  it("should render plain content when there are no tokens", async () => {
    await renderBlame();
    expect(within(rowAt(0)).getByText("const one = 1;")).toBeInTheDocument();
  });

  it("should render plain content for a line whose tokens are null", async () => {
    vi.mocked(useTextHighlight).mockReturnValue([null, null, null]);
    await renderBlame();
    expect(rowAt(1)).toHaveTextContent("const two = 2;");
  });
});

// Contract: Loading blame…, and an error with Retry and a Dismiss that returns to the diff.
describe("BlameView loading and error", () => {
  it("should show Loading blame… with role status while loading", () => {
    vi.mocked(getBlame).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<BlameView repoId={REPO} path={PATH} oid={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading blame…");
  });

  it("should not show the loading status once loaded", async () => {
    await renderBlame();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should show the error message in an alert on failure", async () => {
    vi.mocked(getBlame).mockRejectedValue({ kind: "git", message: "blame boom" });
    renderWithProviders(<BlameView repoId={REPO} path={PATH} oid={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("blame boom");
  });

  it("should fetch the blame again when Retry is clicked", async () => {
    vi.mocked(getBlame).mockRejectedValueOnce({ kind: "git", message: "blame boom" });
    renderWithProviders(<BlameView repoId={REPO} path={PATH} oid={null} />);
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Retry" }),
    );
    expect(await screen.findAllByRole("row")).toHaveLength(3);
    expect(getBlame).toHaveBeenCalledTimes(2);
  });
});

describe("BlameView error", () => {
  it("Dismiss returns to the diff view", async () => {
    useWorkspace.getState().setCentreView(REPO, "blame");
    vi.mocked(getBlame).mockRejectedValue({ kind: "git", message: "blame boom" });
    renderWithProviders(<BlameView repoId={REPO} path={PATH} oid={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(useWorkspace.getState().centreView[REPO]).toBe("diff");
  });
});
