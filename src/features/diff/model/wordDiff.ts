import { WORD_DIFF_MAX_TOKENS } from "./limits";

export interface Range {
  start: number;
  end: number;
}

export interface WordDiff {
  old: Range[];
  new: Range[];
}

const TOKEN = /[\p{L}\p{N}_]+|\s+|./gu;

function tokens(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** Converts per-token "changed" flags into merged character ranges. */
function ranges(toks: string[], changed: boolean[]): Range[] {
  const out: Range[] = [];
  let offset = 0;
  toks.forEach((t, i) => {
    const end = offset + t.length;
    if (changed[i]) {
      const last = out[out.length - 1];
      if (last && last.end === offset) last.end = end;
      else out.push({ start: offset, end });
    }
    offset = end;
  });
  return out;
}

/** Character ranges (UTF-16 offsets) that differ between two lines, by token-level LCS. */
export function wordDiff(a: string, b: string): WordDiff {
  if (a === b) return { old: [], new: [] };
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length > WORD_DIFF_MAX_TOKENS || tb.length > WORD_DIFF_MAX_TOKENS) {
    return {
      old: ranges(
        ta,
        ta.map(() => true),
      ),
      new: ranges(
        tb,
        tb.map(() => true),
      ),
    };
  }
  const n = ta.length;
  const m = tb.length;
  const w = m + 1;
  // dp[i*w + j] = LCS length of ta[i..] and tb[j..]
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        ta[i] === tb[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  // Every token starts as changed; the LCS walk clears the ones both sides share.
  const changedA = new Array<boolean>(n).fill(true);
  const changedB = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      changedA[i] = false;
      changedB[j] = false;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { old: ranges(ta, changedA), new: ranges(tb, changedB) };
}
