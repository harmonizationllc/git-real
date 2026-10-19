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
  /** Pixels per ArrowLeft/ArrowRight press. */
  step: number;
  /**
   * Which column the value sizes, relative to the handle; "after" inverts the pointer delta and
   * ArrowLeft/ArrowRight so dragging towards that column narrows it. Defaults to "before".
   */
  side?: "before" | "after";
  onChange(px: number): void;
  onReset(): void;
}

/** A vertical column separator, resized by pointer drag or the keyboard; double-click resets. */
export function SplitHandle({
  label,
  value,
  min,
  max,
  step,
  side = "before",
  onChange,
  onReset,
}: SplitHandleProps) {
  const sign = side === "after" ? -1 : 1;
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (px: number) => Math.min(max, Math.max(min, px));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(clamp(start.current.value + sign * (e.clientX - start.current.x)));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    start.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const targets: Record<string, number> = {
      ArrowRight: value + sign * step,
      ArrowLeft: value - sign * step,
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
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      tabIndex={0}
      className={styles.handle}
      style={{ width: SPLIT_HANDLE_WIDTH }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
