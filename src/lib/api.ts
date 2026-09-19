import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";

export const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff"];

export interface ImageInfo {
  path: string;
  name: string;
  width: number;
  height: number;
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

/** Maximum width in px and maximum file size in KB (1 KB = 1000 bytes; null = no limit). */
export interface Limits {
  maxWidth: number;
  maxKb: number | null;
}

export const inspectImages = (paths: string[]) =>
  invoke<{ images: ImageInfo[]; rejected: Rejected[] }>("inspect_images", { paths });

export const suggestSlug = (text: string) => invoke<string>("suggest_slug", { text });

export const previewOutput = (args: {
  slug: string;
  firstImage: string;
  sizes: [number, number][];
  maxWidth: number;
  customOutputDir: string | null;
}) => invoke<OutputPreview>("preview_output", args);

export const processImages = (args: {
  paths: string[];
  slug: string;
  customOutputDir: string | null;
  maxWidth: number;
  maxKb: number | null;
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
