import { WORD_DIFF_MAX_TOKENS } from "./limits";

export interface Range {
  start: number;
  end: number;
}

export interface EditUnit {
  old: Range;
  new: Range;
}

const TOKEN = /[\p{L}\p{N}_]+|\s+|./gu;

function tokens(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** offsets[k] is the character offset where token k starts; the last entry is the total length. */
function offsets(toks: string[]): number[] {
  const out = [0];
  for (const t of toks) out.push(out[out.length - 1] + t.length);
  return out;
}

/** One unit per maximal run of unmatched tokens between token-LCS matches of two lines. */
export function lineEdits(a: string, b: string): EditUnit[] {
  if (a === b) return [];
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length > WORD_DIFF_MAX_TOKENS || tb.length > WORD_DIFF_MAX_TOKENS) {
    return [{ old: { start: 0, end: a.length }, new: { start: 0, end: b.length } }];
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
  const oa = offsets(ta);
  const ob = offsets(tb);
  const units: EditUnit[] = [];
  let i = 0;
  let j = 0;
  let runI = 0;
  let runJ = 0;
  const flush = () => {
    if (runI !== i || runJ !== j) {
      units.push({
        old: { start: oa[runI], end: oa[i] },
        new: { start: ob[runJ], end: ob[j] },
      });
    }
  };
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      flush();
      i++;
      j++;
      runI = i;
      runJ = j;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  i = n;
  j = m;
  flush();
  return units;
}

/**
 * Forward builds from `a`, replacing each chosen unit's old range with its new text from `b`.
 * Reverse builds from `b`, replacing each chosen unit's new range with its old text from `a`.
 */
export function applyUnits(
  a: string,
  b: string,
  units: EditUnit[],
  chosen: ReadonlySet<number>,
  forward: boolean,
): string {
  const base = forward ? a : b;
  const other = forward ? b : a;
  let out = "";
  let pos = 0;
  units.forEach((u, k) => {
    if (!chosen.has(k)) return;
    const here = forward ? u.old : u.new;
    const there = forward ? u.new : u.old;
    out += base.slice(pos, here.start) + other.slice(there.start, there.end);
    pos = here.end;
  });
  return out + base.slice(pos);
}
