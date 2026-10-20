import { describe, expect, it } from "vitest";
import { parseConflicts, replacementFor } from "./markers";

const BLOCK = "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\n";

// Contract: a block is <<<<<<< [|||||||] ======= >>>>>>> in order on later lines, with exact offsets and labels.
describe("parseConflicts blocks", () => {
  it("should parse one block with labels and offsets", () => {
    const text = `a\n${BLOCK}b\n`;
    expect(parseConflicts(text)).toEqual([
      {
        from: 2,
        to: 2 + BLOCK.length,
        ours: "x\n",
        base: null,
        theirs: "y\n",
        oursLabel: "HEAD",
        theirsLabel: "feature",
        trailingNewline: true,
      },
    ]);
  });
  it("should parse two blocks in order", () => {
    const second = "<<<<<<< HEAD\nm\n=======\nn\n>>>>>>> feature\n";
    const blocks = parseConflicts(`${BLOCK}mid\n${second}`);
    expect(blocks.map((b) => b.ours)).toEqual(["x\n", "m\n"]);
  });
  it("should parse a diff3 block with base", () => {
    const text = "<<<<<<< HEAD\nx\n||||||| base\nb\n=======\ny\n>>>>>>> feature\n";
    const [block] = parseConflicts(text);
    expect([block.ours, block.base, block.theirs]).toEqual(["x\n", "b\n", "y\n"]);
  });
  it("should parse empty sides", () => {
    const [block] = parseConflicts("<<<<<<< a\n=======\n>>>>>>> b\n");
    expect([block.ours, block.theirs]).toEqual(["", ""]);
  });
  it("should accept a marker with no label", () => {
    const [block] = parseConflicts("<<<<<<<\nx\n=======\ny\n>>>>>>>\n");
    expect([block.oursLabel, block.theirsLabel]).toEqual(["", ""]);
  });
  it("should return no blocks for text without markers", () => {
    expect(parseConflicts("plain\ntext\n")).toEqual([]);
  });
  it("should return no blocks for the empty text", () => {
    expect(parseConflicts("")).toEqual([]);
  });
});

// Contract: malformed or lookalike markers are ordinary text and never form a block.
describe("parseConflicts malformed input", () => {
  it("should ignore a lone separator line", () => {
    expect(parseConflicts("Title\n=======\nbody\n")).toEqual([]);
  });
  it("should ignore an unterminated start marker", () => {
    expect(parseConflicts("<<<<<<< HEAD\nx\n=======\ny\n")).toEqual([]);
  });
  it("should ignore a block that has no separator", () => {
    expect(parseConflicts("<<<<<<< HEAD\nx\n>>>>>>> feature\n")).toEqual([]);
  });
  it("should ignore markers that are not at line start", () => {
    expect(parseConflicts(" <<<<<<< HEAD\nx\n =======\ny\n >>>>>>> feature\n")).toEqual([]);
  });
  const ok = { start: "<<<<<<<", sep: "=======", end: ">>>>>>>" };
  const doc = (m: typeof ok) => `${m.start} a\nx\n${m.sep}\ny\n${m.end} b\n`;
  it("should accept the baseline well-formed block", () => {
    expect(parseConflicts(doc(ok))).toHaveLength(1);
  });
  it.each([
    ["start", "<", 6],
    ["start", "<", 8],
    ["sep", "=", 6],
    ["sep", "=", 8],
    ["end", ">", 6],
    ["end", ">", 8],
  ] as const)("should ignore a %s marker with %s repeated %i times", (key, ch, n) => {
    expect(parseConflicts(doc({ ...ok, [key]: ch.repeat(n) }))).toEqual([]);
  });
  it.each([6, 8])("should not treat a %i-long ||||||| as a base marker", (n) => {
    const text = `<<<<<<< a\nx\n${"|".repeat(n)} base\nb\n=======\ny\n>>>>>>> c\n`;
    const [block] = parseConflicts(text);
    expect(block.base).toBeNull();
  });
  it("should ignore a marker glued to text without a space", () => {
    expect(parseConflicts("<<<<<<<HEAD\nx\n=======\ny\n>>>>>>> feature\n")).toEqual([]);
  });
  it("should ignore a >>>>>>> before ======= and keep scanning", () => {
    const text = "<<<<<<< HEAD\nx\n>>>>>>> early\ny\n=======\nz\n>>>>>>> late\n";
    const [block] = parseConflicts(text);
    expect([block.ours, block.theirs, block.theirsLabel]).toEqual([
      "x\n>>>>>>> early\ny\n",
      "z\n",
      "late",
    ]);
  });
  it("should let a second ||||||| override the first", () => {
    const text = "<<<<<<< HEAD\nx\n||||||| one\nb1\n||||||| two\nb2\n=======\ny\n>>>>>>> f\n";
    const [block] = parseConflicts(text);
    expect([block.ours, block.base]).toEqual(["x\n||||||| one\nb1\n", "b2\n"]);
  });
  it("should restart the block at a second start marker before the separator", () => {
    const text = "<<<<<<< one\nnoise\n<<<<<<< two\nx\n=======\ny\n>>>>>>> feature\n";
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].oursLabel).toBe("two");
    expect(blocks[0].from).toBe(text.indexOf("<<<<<<< two"));
  });
});

// Contract: replacementFor yields the chosen text and never invents a newline at the end of the file.
describe("replacementFor", () => {
  const [block] = parseConflicts(BLOCK);

  it("should return ours", () => {
    expect(replacementFor(block, "ours")).toBe("x\n");
  });
  it("should return theirs", () => {
    expect(replacementFor(block, "theirs")).toBe("y\n");
  });
  it("should return ours followed by theirs for both", () => {
    expect(replacementFor(block, "both")).toBe("x\ny\n");
  });
});

describe("parseConflicts at the end of the file", () => {
  const unterminated = "<<<<<<< a\nx\n=======\ny\n>>>>>>> b";

  it("should report trailingNewline false when the block ends the file without a newline", () => {
    expect(parseConflicts(unterminated)[0].trailingNewline).toBe(false);
  });
  it("should drop the final newline from the replacement when the block ends the file", () => {
    const [block] = parseConflicts(unterminated);
    expect(replacementFor(block, "ours")).toBe("x");
  });
  it("should replace with the empty text when the chosen side is empty", () => {
    const [block] = parseConflicts("<<<<<<< a\n=======\ny\n>>>>>>> b");
    expect(replacementFor(block, "ours")).toBe("");
  });
  it("should end the block at the end of the text", () => {
    const [block] = parseConflicts(unterminated);
    expect(block.to).toBe(unterminated.length);
  });
});

// Contract: markers that appear after the separator are plain theirs text and never move the block's anchors.
describe("parseConflicts markers inside theirs", () => {
  it("should keep a ||||||| after the separator as theirs text with no base", () => {
    const [block] = parseConflicts("<<<<<<< a\nx\n=======\ny\n||||||| z\n>>>>>>> b\n");
    expect([block.ours, block.base, block.theirs]).toEqual(["x\n", null, "y\n||||||| z\n"]);
  });
  it("should keep a second ======= as theirs text and not move the separator", () => {
    const [block] = parseConflicts("<<<<<<< a\nx\n=======\ny\n=======\nz\n>>>>>>> b\n");
    expect([block.ours, block.theirs]).toEqual(["x\n", "y\n=======\nz\n"]);
  });
  it("should keep a diff3 base intact when a ||||||| also appears in theirs", () => {
    const [block] = parseConflicts(
      "<<<<<<< a\nx\n||||||| base\nb\n=======\ny\n||||||| late\n>>>>>>> b\n",
    );
    expect([block.ours, block.base, block.theirs]).toEqual(["x\n", "b\n", "y\n||||||| late\n"]);
  });
});

// Contract: degenerate texts produce no blocks and never throw.
describe("parseConflicts degenerate text", () => {
  it("should return no blocks for a lone newline", () => {
    expect(parseConflicts("\n")).toEqual([]);
  });
  it("should return no blocks for a lone marker line", () => {
    expect(parseConflicts("<<<<<<< HEAD")).toEqual([]);
  });
});
