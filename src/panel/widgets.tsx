import { useEffect, useState } from "react";

export const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs 0 → 1 with smoothstep easing, so the value eases into and out of its
 * own movement. One ramp per thing that counts, each with its own delay.
 */
export function useRamp(duration: number, delay: number): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (reducedMotion()) {
      setProgress(1);
      return;
    }
    let frame = 0;
    const started = performance.now() + delay;
    const step = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - started) / duration));
      setProgress(p * p * (3 - 2 * p));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [duration, delay]);

  return progress;
}

/** A number counting up with a ramp. Needs tabular figures, or its width jitters. */
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

/** Swaps one line of text for another: old out in 140 ms, new in over 240 ms. */
export function Swap({ text, className = "" }: { text: string; className?: string }) {
  const [shown, setShown] = useState(text);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (text === shown) return;
    if (reducedMotion()) {
      setShown(text);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => {
      setShown(text);
      setLeaving(false);
    }, 140);
    return () => clearTimeout(timer);
  }, [text, shown]);

  return (
    <span key={shown} className={`${leaving ? "swap-out" : "swap-in"} ${className}`}>
      {shown}
    </span>
  );
}
