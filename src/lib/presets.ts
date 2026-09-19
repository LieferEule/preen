export interface Preset {
  name: string;
  label: string;
  maxWidth: number;
  maxKb: number;
}

export const PRESETS: Preset[] = [
  { name: "content", label: "Inhaltsbild", maxWidth: 1600, maxKb: 260 },
  { name: "hero", label: "Hero", maxWidth: 2400, maxKb: 500 },
];

export const WIDTH_RANGE = { min: 800, max: 3200, step: 100 };
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
