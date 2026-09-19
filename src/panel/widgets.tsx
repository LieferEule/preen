import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A popover anchored under its container, flipping above it when it would
 * otherwise run off the bottom of the panel.
 */
export function Popover(props: {
  width: number;
  align: "left" | "right";
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setAbove(rect.bottom > window.innerHeight - 8);
  }, []);

  return (
    <div
      ref={box}
      data-tauri-drag-region="false"
      onClick={(e) => e.stopPropagation()}
      className={`pop absolute z-10 overflow-hidden rounded-[18px] bg-white/95 p-1 shadow-[0_18px_40px_rgba(6,22,26,0.28),0_0_0_1px_rgba(15,44,43,0.08)] ${
        above ? "bottom-full mb-1.5" : "top-full mt-1.5"
      } ${props.align === "left" ? "left-0" : "right-0"}`}
      style={{ width: props.width }}
    >
      {props.children}
    </div>
  );
}

/**
 * Runs 0 → 1 over 700 ms with easing 1 - (1 - p)³, after the check has popped.
 * One ramp drives the number and the bar, so they move together.
 */
export function useRamp(duration = 700, delay = 200): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setProgress(1);
      return;
    }
    let frame = 0;
    const started = performance.now() + delay;
    const step = (now: number) => {
      const linear = Math.min(1, Math.max(0, (now - started) / duration));
      setProgress(1 - Math.pow(1 - linear, 3));
      if (linear < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [duration, delay]);

  return progress;
}

/** A number counting up with the ramp. Needs tabular figures, or its width jitters. */
export function Counting({ value, digits = 0 }: { value: number; digits?: number }) {
  return (
    <>
      {value.toLocaleString("de-DE", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}
    </>
  );
}
