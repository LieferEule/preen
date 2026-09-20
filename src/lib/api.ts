import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";

export const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "heif", "tif", "tiff"];

export interface ImageInfo {
  path: string;
  name: string;
  width: number;
  height: number;
  /** Size of the original file in bytes. */
  bytes: number;
}

export interface Rejected {
  path: string;
  name: string;
  reason: string;
}

export interface OutputPreview {
  outputDir: string;
  items: { fileName: string; width: number; height: number }[];
}

export interface OutputFile {
  path: string;
  fileName: string;
  width: number;
  height: number;
  bytes: number;
  quality: number;
  limitMissed: boolean;
  /** The size limit forced the picture below what the preset would give it. */
  emergencyScaled: boolean;
}

export interface ImageResult {
  source: string;
  output: OutputFile | null;
  error: string | null;
}

export interface BatchResult {
  outputDir: string;
  images: ImageResult[];
}

/**
 * Long edge in px, pixel cap in megapixels, the floor the emergency scaling
 * stops at, and the file size in KB (1 KB = 1000 bytes; null = no limit).
 */
export interface Limits {
  longEdge: number;
  maxMegapixels: number;
  minLongEdge: number;
  maxKb: number | null;
}

export const inspectImages = (paths: string[]) =>
  invoke<{ images: ImageInfo[]; rejected: Rejected[] }>("inspect_images", { paths });

export const suggestSlug = (text: string) => invoke<string>("suggest_slug", { text });
/** The name suggested from an original's file name; empty for machine names. */
export const suggestName = (fileStem: string) => invoke<string>("suggest_name", { fileStem });

export const previewOutput = (args: {
  slug: string;
  firstImage: string;
  sizes: [number, number][];
  longEdge: number;
  maxMegapixels: number;
  customOutputDir: string | null;
}) => invoke<OutputPreview>("preview_output", args);

export const processImages = (args: {
  paths: string[];
  slug: string;
  customOutputDir: string | null;
  limits: Limits;
}) => invoke<BatchResult>("process_images", args);

export const onProgress = (cb: (p: { done: number; total: number }) => void): Promise<UnlistenFn> =>
  listen<{ done: number; total: number }>("preen://progress", (e) => cb(e.payload));

// Persisted: the chosen output folder (null = next to the originals) and the last limits.
let store: Promise<Store> | null = null;
const settings = () => (store ??= load("settings.json", { autoSave: true, defaults: {} }));

export async function loadOutputDir(): Promise<string | null> {
  return (await (await settings()).get<string | null>("outputDir")) ?? null;
}

export async function saveOutputDir(dir: string | null): Promise<void> {
  await (await settings()).set("outputDir", dir);
}

export async function loadLimits(): Promise<Limits | null> {
  return (await (await settings()).get<Limits>("limits")) ?? null;
}

export async function saveLimits(limits: Limits): Promise<void> {
  await (await settings()).set("limits", limits);
}

// ---------------------------------------------------------------------------
// Etappe 2: panel, tray, shortcut, app settings
// ---------------------------------------------------------------------------

/** "source" (next to the original), "desktop", or an absolute folder path. */
export type Target = string;
export const TARGET_SOURCE = "source";
export const TARGET_DESKTOP = "desktop";

export interface AppSettings {
  shortcut: string;
  showInDock: boolean;
  defaultTarget: Target;
  recentTargets: string[];
  /** Seconds the resting panel waits before hiding itself; 0 is off. */
  autoHideSeconds: number;
}

export const appSettings = () => invoke<AppSettings>("app_settings");
export const shortcutLabel = (accelerator: string) =>
  invoke<string>("shortcut_label", { accelerator });
export const setShortcut = (accelerator: string) => invoke<void>("set_shortcut", { accelerator });
export const setShowInDock = (show: boolean) => invoke<void>("set_show_in_dock", { show });
export const setDefaultTarget = (target: Target) => invoke<void>("set_default_target", { target });
export const rememberTarget = (path: string) => invoke<void>("remember_target", { path });
export const targetIsUsable = (path: string) => invoke<boolean>("target_is_usable", { path });

export const thumbnail = (path: string, size: number) =>
  invoke<string>("thumbnail", { path, size });

export const hidePanel = () => invoke<void>("hide_panel");
/** `durationMs` of 0 snaps — used for reduced motion and plain content changes. */
export const resizePanel = (height: number, loaded: boolean, durationMs: number) =>
  invoke<void>("resize_panel", { height, loaded, durationMs });
export const openSettingsWindow = () => invoke<void>("open_settings_window");
/** Hiding through a command works without a window permission. */
export const hideSettings = () => invoke<void>("hide_settings");
export const setAutoHideSeconds = (seconds: number) =>
  invoke<void>("set_auto_hide_seconds", { seconds });
export const resizeSettingsWindow = (height: number) =>
  invoke<void>("resize_settings_window", { height });
export const quitApp = () => invoke<void>("quit_app");
export const debugLog = (message: string) => invoke<void>("debug_log", { message });

export const onPanelShown = (cb: () => void): Promise<UnlistenFn> =>
  listen("preen://panel-shown", () => cb());

/** Images handed to the app from outside: "Öffnen mit", or a path on the command line. */
export const onOpenFiles = (cb: (paths: string[]) => void): Promise<UnlistenFn> =>
  listen<string[]>("preen://open-files", (e) => cb(e.payload));

/** The panel has been hidden long enough to drop what was loaded. */
export const onForgetImages = (cb: () => void): Promise<UnlistenFn> =>
  listen("preen://forget-images", () => cb());

export const onSettingsChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("preen://settings-changed", () => cb());

export async function loadPreset(): Promise<string | null> {
  return (await (await settings()).get<string>("preset")) ?? null;
}

export async function savePreset(name: string): Promise<void> {
  await (await settings()).set("preset", name);
}
