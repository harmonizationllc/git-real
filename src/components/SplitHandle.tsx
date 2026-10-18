import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import styles from "./SplitHandle.module.css";

export interface SplitHandleProps {
  label: string;
  value: number;
  min: number;
  /** Infinity while the container is unmeasured. */
  max: number;
  /** Pixels per ArrowLeft/ArrowRight press. */
  step: number;
  onChange(px: number): void;
  onReset(): void;
}

/** A vertical column separator, resized by pointer drag or the keyboard; double-click resets. */
export function SplitHandle({ label, value, min, max, step, onChange, onReset }: SplitHandleProps) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (px: number) => Math.min(max, Math.max(min, px));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(clamp(start.current.value + e.clientX - start.current.x));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    start.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const targets: Record<string, number> = {
      ArrowRight: value + step,
      ArrowLeft: value - step,
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
