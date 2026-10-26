import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import styles from "./SplitHandle.module.css";

/** The handle's width in pixels; layouts subtract it from the space the columns share. */
export const SPLIT_HANDLE_WIDTH = 6;

export interface SplitHandleProps {
  label: string;
  value: number;
  min: number;
  /** Infinity while the container is unmeasured. */
  max: number;
  /** Pixels per arrow-key press along the handle's axis. */
  step: number;
  /**
   * Which column the value sizes, relative to the handle; "after" inverts the pointer delta and
   * ArrowLeft/ArrowRight so dragging towards that column narrows it. Defaults to "before".
   */
  side?: "before" | "after";
  /**
   * "vertical" separates columns (horizontal drag, ArrowLeft/ArrowRight); "horizontal" separates
   * stacked sections (vertical drag, ArrowUp/ArrowDown). Defaults to "vertical".
   */
  orientation?: "vertical" | "horizontal";
  onChange(px: number): void;
  onReset(): void;
}

/** A column or section separator, resized by pointer drag or the keyboard; double-click resets. */
export function SplitHandle({
  label,
  value,
  min,
  max,
  step,
  side = "before",
  orientation = "vertical",
  onChange,
  onReset,
}: SplitHandleProps) {
  const sign = side === "after" ? -1 : 1;
  const horizontal = orientation === "horizontal";
  const pos = (e: PointerEvent<HTMLDivElement>) => (horizontal ? e.clientY : e.clientX);
  const [grow, shrink] = horizontal ? ["ArrowDown", "ArrowUp"] : ["ArrowRight", "ArrowLeft"];
  const start = useRef<{ pos: number; value: number } | null>(null);
  const clamp = (px: number) => Math.min(max, Math.max(min, px));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    start.current = { pos: pos(e), value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(clamp(start.current.value + sign * (pos(e) - start.current.pos)));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    start.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const targets: Record<string, number> = {
      [grow]: value + sign * step,
      [shrink]: value - sign * step,
      Home: min,
      End: max,
    };
    const next = targets[e.key];
    // Unhandled keys, and End while max is unbounded, keep their default behaviour.
    if (next === undefined || !Number.isFinite(next)) return;
    e.preventDefault();
    onChange(clamp(next));
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      tabIndex={0}
      className={horizontal ? `${styles.handle} ${styles.horizontal}` : styles.handle}
      style={horizontal ? { height: SPLIT_HANDLE_WIDTH } : { width: SPLIT_HANDLE_WIDTH }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
