export interface Preset {
  name: string;
  label: string;
  /** The longer side of the output, whichever that is. */
  longEdge: number;
  /**
   * Pixel cap. The long edge alone is not enough: at 2400 a portrait photo
   * arrives at 2400 × 3200 — 7,7 MP against a 16:9 hero's 3,2 — and no
   * quality setting brings that file back under the size limit.
   */
  maxMegapixels: number;
  maxKb: number;
  /**
   * Floor for the emergency scaling: the long edge of the next preset down.
   * Under it the picture is not what was asked for any more — an 1182 px
   * "hero" is smaller than an inhaltsbild — so the run stops shrinking and
   * reports an oversized file instead.
   */
  minLongEdge: number;
}

export const PRESETS: Preset[] = [
  {
    name: "content",
    label: "Inhaltsbild",
    longEdge: 1600,
    maxMegapixels: 1.8,
    maxKb: 260,
    minLongEdge: 1000,
  },
  {
    name: "hero",
    label: "Hero",
    longEdge: 2400,
    maxMegapixels: 3.5,
    maxKb: 500,
    minLongEdge: 1600,
  },
];

export const EDGE_RANGE = { min: 800, max: 3200, step: 100 };
export const SIZE_RANGE = { min: 80, max: 800, step: 10 };

export const presetByName = (name: string | null) =>
  PRESETS.find((p) => p.name === name) ?? PRESETS[0];

/** 1 KB = 1000 bytes, like Finder; megabytes once the number gets long. */
export const kb = (bytes: number) => {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
  }
  return `${(bytes / 1000).toLocaleString("de-DE", { maximumFractionDigits: bytes < 10000 ? 1 : 0 })} KB`;
};

export const mp = (megapixels: number) =>
  `${megapixels.toLocaleString("de-DE", { maximumFractionDigits: 1 })} MP`;
