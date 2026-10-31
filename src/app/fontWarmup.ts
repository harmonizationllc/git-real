import {
  DIFF_SIZE_TOKEN,
  FONT_FAMILY_TOKENS,
  FONT_WEIGHTS,
  TEXT_SIZE_TOKENS,
} from "../styles/fontTokens";

/**
 * WebKitGTK resolves each new (family, size, weight) through fontconfig the first time it is
 * styled, which costs several ms per combination when cold. The token contract keeps the set of
 * combinations finite; this module lays each one out once on the start screen, a frame budget at a
 * time, so opening the first repository never pays for them.
 */

export interface FontWarmupOptions {
  /** The element whose tokens are read and which receives `data-fonts-warm`. */
  root?: HTMLElement;
  /** Time a batch may spend before yielding to the next frame; one combo always runs. */
  frameBudgetMs?: number;
  requestFrame?: (cb: () => void) => void;
  now?: () => number;
  /** Resolves a custom property to its value; defaults to the root's computed style. */
  readToken?: (name: string) => string;
}

/** One font combination, with token names resolved to values. */
export interface FontCombo {
  family: string;
  size: string;
  weight: string;
}

const SIZE_TOKENS = [...TEXT_SIZE_TOKENS, DIFF_SIZE_TOKEN];
const [UI, MONO_UI, MONO] = FONT_FAMILY_TOKENS;
const [NORMAL, SEMIBOLD, BOLD] = FONT_WEIGHTS;

/** Family and weight pairs, pane-first: what the first repository paint uses most comes first. */
const ORDER: [string, string][] = [
  [UI, NORMAL],
  [UI, SEMIBOLD],
  [MONO_UI, NORMAL],
  [MONO_UI, SEMIBOLD],
  [UI, BOLD],
  [MONO_UI, BOLD],
  [MONO, NORMAL],
  [MONO, SEMIBOLD],
  [MONO, BOLD],
];

const HOST_STYLE = { position: "absolute", left: "-9999px", top: "0", visibility: "hidden" };

const keyOf = (c: FontCombo) => `${c.family}|${c.size}|${c.weight}`;

/** Combos already laid out in this page, keyed by resolved values. */
const warmed = new Set<string>();
let cancelActive: (() => void) | null = null;

/** Every combination the stylesheets can produce, pane-first, without repeated resolved values. */
export function warmupOrder(read: (name: string) => string): FontCombo[] {
  const sizes = SIZE_TOKENS.map(read);
  const seen = new Set<string>();
  const out: FontCombo[] = [];
  for (const [familyToken, weight] of ORDER) {
    const family = read(familyToken);
    for (const size of sizes) {
      const combo = { family, size, weight };
      const key = keyOf(combo);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(combo);
    }
  }
  return out;
}

/**
 * Starts warming every cold combination after the next frame and a macrotask, superseding any run
 * still in flight; returns the cancel. Completion removes the off-screen host and sets
 * `data-fonts-warm="true"` on the root; cancel removes the host without setting it.
 */
export function startFontWarmup(options: FontWarmupOptions = {}): () => void {
  if (typeof document === "undefined") return () => {};
  const root = options.root ?? document.documentElement;
  const budget = options.frameBudgetMs ?? 40;
  const requestFrame = options.requestFrame ?? ((cb) => void window.requestAnimationFrame(cb));
  const now = options.now ?? (() => performance.now());
  const readToken =
    options.readToken ?? ((name) => getComputedStyle(root).getPropertyValue(name).trim());

  cancelActive?.();
  let cancelled = false;
  let host: HTMLDivElement | null = null;
  let pending: FontCombo[] | null = null;

  const cancel = () => {
    cancelled = true;
    host?.remove();
    host = null;
    if (cancelActive === cancel) cancelActive = null;
  };

  const warm = (combo: FontCombo) => {
    if (host === null) {
      host = document.createElement("div");
      host.dataset.fontWarmup = "";
      host.setAttribute("aria-hidden", "true");
      Object.assign(host.style, HOST_STYLE);
      document.body.appendChild(host);
    }
    const span = document.createElement("span");
    span.textContent = "Ag 0";
    span.style.fontFamily = combo.family;
    span.style.fontSize = combo.size;
    span.style.fontWeight = combo.weight;
    host.appendChild(span);
    void span.offsetWidth; // forces layout, which resolves the font
    warmed.add(keyOf(combo));
  };

  const runBatch = () => {
    if (cancelled) return;
    // Resolved here, not at start, so a caller mid-style-change never forces a style recalc.
    pending ??= warmupOrder(readToken).filter((c) => !warmed.has(keyOf(c)));
    const batchStart = now();
    do {
      const next = pending.shift();
      if (next === undefined) break;
      warm(next);
    } while (pending.length > 0 && now() - batchStart < budget);
    if (pending.length > 0) {
      requestFrame(runBatch);
      return;
    }
    cancel();
    root.dataset.fontsWarm = "true";
  };

  cancelActive = cancel;
  requestFrame(() => setTimeout(runBatch, 0));
  return cancel;
}

/** Forgets warmed combos and any run in flight. */
export function resetFontWarmupForTests(): void {
  cancelActive?.();
  warmed.clear();
}
