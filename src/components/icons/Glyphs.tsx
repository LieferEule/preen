/** The few line icons the panel and settings window need. */
type Props = { className?: string; size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const FolderIcon = ({ className, size = 14 }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M1.8 4.2c0-.6.5-1 1-1h3l1.4 1.6h5c.6 0 1 .5 1 1v5.4c0 .6-.4 1-1 1H2.8c-.5 0-1-.4-1-1V4.2Z" />
  </svg>
);

export const SlidersIcon = ({ className, size = 14 }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M2 5h8M12.5 5H14M2 11h2.5M7 11h7" />
    <circle cx="11" cy="5" r="1.6" />
    <circle cx="5.5" cy="11" r="1.6" />
  </svg>
);

export const ChevronIcon = ({ className, size = 12 }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4.5 6.5 8 10l3.5-3.5" />
  </svg>
);

export const CheckIcon = ({ className, size = 14 }: Props) => (
  <svg {...base(size)} className={className} strokeWidth={2}>
    <path d="M3.5 8.5 6.5 11.5 12.5 5" />
  </svg>
);

export const CloseIcon = ({ className, size = 13 }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
  </svg>
);
