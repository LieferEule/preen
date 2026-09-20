/** The line icons the panel and settings window need, traced from
 *  design/panel-reference.html so both windows draw the same shapes. */
type Props = { className?: string; size?: number; strokeWidth?: number };

const base = (size: number, strokeWidth: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const FolderIcon = ({ className, size = 15, strokeWidth = 1.5 }: Props) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M2 4.2 A1.2 1.2 0 0 1 3.2 3 H6.2 L7.6 4.8 H12.8 A1.2 1.2 0 0 1 14 6 V12 A1.2 1.2 0 0 1 12.8 13.2 H3.2 A1.2 1.2 0 0 1 2 12 Z" />
  </svg>
);

export const SlidersIcon = ({ className, size = 15, strokeWidth = 1.5 }: Props) => (
  <svg {...base(size, strokeWidth)} className={className} strokeLinejoin="miter">
    <path d="M2.5 4.5 H4.1" />
    <path d="M7.9 4.5 H13.5" />
    <circle cx="6" cy="4.5" r="1.9" />
    <path d="M2.5 11.5 H8.1" />
    <path d="M11.9 11.5 H13.5" />
    <circle cx="10" cy="11.5" r="1.9" />
  </svg>
);

export const ChevronIcon = ({ className, size = 13, strokeWidth = 1.8 }: Props) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M5 6.5 L8 9.5 L11 6.5" />
  </svg>
);

export const CheckIcon = ({ className, size = 12, strokeWidth = 2.4 }: Props) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M3 8.5 L6.5 12 L13 4.5" />
  </svg>
);
