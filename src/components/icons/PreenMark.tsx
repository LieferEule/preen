import React from "react";

interface PreenMarkProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

/**
 * The Preen feather.
 *
 * One rectangle per run of the original 12x14 pixel grid, so the edges
 * land on whole units at any size instead of being traced into curves.
 * Fills with `currentColor` and follows whatever accent token it sits in.
 */
const PreenMark: React.FC<PreenMarkProps> = ({
  size = 24,
  width,
  height,
  className,
  ...props
}) => (
  <svg
    viewBox="0 0 12 14"
    width={width ?? size}
    height={height ?? size}
    className={className}
    fill="currentColor"
    shapeRendering="crispEdges"
    role="img"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <rect x="6" y="0" width="2" height="1" />
    <rect x="5" y="1" width="4" height="1" />
    <rect x="4" y="2" width="2" height="2" />
    <rect x="7" y="2" width="3" height="1" />
    <rect x="7" y="3" width="4" height="3" />
    <rect x="3" y="4" width="3" height="3" />
    <rect x="7" y="6" width="3" height="2" />
    <rect x="4" y="7" width="2" height="2" />
    <rect x="7" y="8" width="2" height="1" />
    <rect x="5" y="9" width="1" height="1" />
    <rect x="7" y="9" width="1" height="1" />
    <rect x="6" y="10" width="2" height="4" />
  </svg>
);

export default PreenMark;
