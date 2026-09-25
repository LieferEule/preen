import { useLayoutEffect, useRef, useState } from "react";

/**
 * A popover that grows out of its trigger: the transform origin sits in the
 * corner the button is on, so it does not appear out of nowhere. It flips
 * above the trigger when it would otherwise run off the bottom of the panel.
 *
 * Kept mounted and driven by `open`, so the closing half of the movement can
 * play out instead of the element vanishing.
 */
export function Popover(props: {
  open: boolean;
  width: number;
  align: "left" | "right";
  label: string;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);

  useLayoutEffect(() => {
    const element = box.current;
    const anchor = element?.parentElement;
    if (!props.open || !element || !anchor) return;
    // Measured against the trigger row and the popover's own layout height,
    // never against where the popover currently sits — otherwise the last
    // decision feeds the next one and the side flips back and forth.
    const room = window.innerHeight - anchor.getBoundingClientRect().bottom - 8;
    setAbove(element.offsetHeight + 6 > room);
  }, [props.open]);

  const duration = props.open ? 260 : 180;
  return (
    <div
      ref={box}
      data-tauri-drag-region="false"
      data-popover
      role="group"
      aria-label={props.label}
      aria-hidden={!props.open}
      className={`absolute z-10 overflow-hidden rounded-[18px] bg-white/95 p-1 shadow-[0_18px_40px_rgba(6,22,26,0.28),0_0_0_1px_rgba(15,44,43,0.08)] ${
        above ? "bottom-full mb-1.5" : "top-full mt-1.5"
      } ${props.align === "left" ? "left-0" : "right-0"}`}
      style={{
        width: props.width,
        transformOrigin: `${above ? "bottom" : "top"} ${props.align}`,
        opacity: props.open ? 1 : 0,
        transform: props.open
          ? "scale(1) translateY(0)"
          : `scale(0.96) translateY(${above ? 6 : -6}px)`,
        pointerEvents: props.open ? "auto" : "none",
        transition: `opacity ${duration}ms var(--ease-enter), transform ${duration}ms var(--ease-enter)`,
      }}
    >
      {props.children}
    </div>
  );
}
