import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  SUPPORTED_EXTENSIONS,
  inspectImages,
  loadLimits,
  loadOutputDir,
  onProgress,
  previewOutput,
  processImages,
  saveLimits,
  saveOutputDir,
  suggestSlug,
  type BatchResult,
  type ImageInfo,
  type Limits,
  type OutputPreview,
  type Rejected,
} from "./lib/api";

const PRESETS: ({ label: string } & Limits)[] = [
  { label: "Inhaltsbild", maxWidth: 1600, maxKb: 260 },
  { label: "Hero", maxWidth: 2400, maxKb: 500 },
];
const DEFAULT_LIMITS: Limits = PRESETS[0];
const WIDTH_RANGE = { min: 400, max: 3200, step: 100 };
// One step past the last KB value means "keine Grenze".
const SIZE_RANGE = { min: 50, max: 1000, step: 10 };
const NO_LIMIT_POSITION = SIZE_RANGE.max + SIZE_RANGE.step;

type Phase =
  | { kind: "idle" }
  | { kind: "processing"; done: number; total: number }
  | { kind: "done"; result: BatchResult; limits: Limits }
  | { kind: "failed"; message: string };

// 1 KB = 1000 bytes, like Finder.
const kb = (bytes: number) =>
  `${(bytes / 1000).toLocaleString("de-DE", { maximumFractionDigits: bytes < 10000 ? 1 : 0 })} KB`;

export default function App() {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [fineTuning, setFineTuning] = useState(false);
  const [customDir, setCustomDir] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutputPreview | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [home, setHome] = useState("");
  const busy = phase.kind === "processing";
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    loadOutputDir().then(setCustomDir);
    loadLimits().then((l) => l && setLimits(l));
    homeDir().then(setHome);
  }, []);

  const updateLimits = (next: Limits) => {
    setLimits(next);
    saveLimits(next);
  };

  // Until edited by hand, the file name follows the first original's name.
  const suggestionSource = images[0]?.name.replace(/\.[^.]+$/, "") ?? "";
  useEffect(() => {
    if (slugTouched) return;
    if (!suggestionSource) {
      setSlug("");
      return;
    }
    let stale = false;
    suggestSlug(suggestionSource).then((s) => !stale && setSlug(s));
    return () => {
      stale = true;
    };
  }, [suggestionSource, slugTouched]);

  // Cleaned up on leaving the field; emptying it brings the suggestion back.
  const normalizeSlug = async () => {
    if (!slug.trim()) setSlugTouched(false);
    else setSlug(await suggestSlug(slug));
  };

  const addPaths = useCallback(async (paths: string[]) => {
    if (busyRef.current || paths.length === 0) return;
    const { images: found, rejected } = await inspectImages(paths);
    setPhase((p) => (p.kind === "done" || p.kind === "failed" ? { kind: "idle" } : p));
    setImages((current) => {
      const seen = new Set(current.map((i) => i.path));
      return [...current, ...found.filter((i) => !seen.has(i.path))];
    });
    setRejected(rejected);
  }, []);

  // Native drag & drop: the webview hands us real file paths.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const { type } = event.payload;
      if (type === "enter" || type === "over") setDragging(!busyRef.current);
      else if (type === "leave") setDragging(false);
      else if (type === "drop") {
        setDragging(false);
        addPaths(event.payload.paths);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addPaths]);

  useEffect(() => {
    const unlisten = onProgress(({ done, total }) =>
      setPhase((p) => (p.kind === "processing" ? { kind: "processing", done, total } : p)),
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Live preview of file names, sizes and output folder.
  const phaseKind = phase.kind;
  useEffect(() => {
    if (images.length === 0) {
      setPreview(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      previewOutput({
        slug,
        firstImage: images[0].path,
        sizes: images.map((i) => [i.width, i.height]),
        maxWidth: limits.maxWidth,
        customOutputDir: customDir,
      }).then((p) => !stale && setPreview(p));
    }, 80);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [images, slug, limits.maxWidth, customDir, phaseKind]);

  const pickFiles = async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Bilder", extensions: SUPPORTED_EXTENSIONS }],
    });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
  };

  const pickFolder = async () => {
    const dir = await open({ directory: true, defaultPath: customDir ?? undefined });
    if (typeof dir === "string") {
      setCustomDir(dir);
      saveOutputDir(dir);
    }
  };

  const resetFolder = () => {
    setCustomDir(null);
    saveOutputDir(null);
  };

  const run = async () => {
    if (images.length === 0 || busy) return;
    const used = limits;
    setPhase({ kind: "processing", done: 0, total: images.length });
    try {
      const result = await processImages({
        paths: images.map((i) => i.path),
        slug,
        customOutputDir: customDir,
        maxWidth: used.maxWidth,
        maxKb: used.maxKb,
      });
      setPhase({ kind: "done", result, limits: used });
    } catch (e) {
      setPhase({ kind: "failed", message: String(e) });
    }
  };

  const startOver = () => {
    setImages([]);
    setRejected([]);
    setSlugTouched(false);
    setPhase({ kind: "idle" });
  };

  const shortPath = (p: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);
  const activePreset = PRESETS.find((p) => p.maxWidth === limits.maxWidth && p.maxKb === limits.maxKb);

  if (phase.kind === "done") {
    return (
      <main className="flex h-screen flex-col gap-4 p-5 select-none">
        <Results result={phase.result} limits={phase.limits} shortPath={shortPath} onStartOver={startOver} />
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col gap-4 p-5 select-none">
      <DropArea
        images={images}
        preview={preview}
        dragging={dragging}
        disabled={busy}
        onPick={pickFiles}
        onRemove={(path) => setImages((c) => c.filter((i) => i.path !== path))}
      />

      {rejected.length > 0 && (
        <ul className="space-y-0.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          {rejected.map((r) => (
            <li key={r.path}>
              <span className="font-medium">{r.name}</span> – {r.reason}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1.5">
        <label htmlFor="slug" className="field-label">
          Dateiname
        </label>
        <div className="flex items-center rounded-lg border border-line bg-field focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
          <input
            id="slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            onBlur={normalizeSlug}
            onKeyDown={(e) => e.key === "Enter" && run()}
            disabled={busy}
            placeholder={images.length ? "" : "wird aus dem ersten Bild vorgeschlagen"}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-2 pl-3 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-faint"
          />
          <span className="pr-3 font-mono text-[13px] text-faint">
            {images.length > 1 ? "-01.webp" : ".webp"}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Voreinstellung">
          {PRESETS.map((p) => {
            const active = p === activePreset;
            return (
              <button
                key={p.label}
                role="radio"
                aria-checked={active}
                onClick={() => updateLimits({ maxWidth: p.maxWidth, maxKb: p.maxKb })}
                disabled={busy}
                className={`rounded-lg border px-3 py-1.5 text-left transition-colors ${
                  active ? "border-accent bg-accent/10" : "border-line hover:border-accent/50"
                }`}
              >
                <div className={`text-sm font-medium ${active ? "text-accent" : ""}`}>{p.label}</div>
                <div className="text-[11px] text-muted tabular-nums">
                  {p.maxWidth} px · {p.maxKb} KB
                </div>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setFineTuning((v) => !v)}
          aria-expanded={fineTuning}
          className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-fg"
        >
          <span className={`inline-block transition-transform ${fineTuning ? "rotate-90" : ""}`}>›</span>
          Feineinstellung
          {!activePreset && !fineTuning && (
            <span className="ml-auto tabular-nums">
              {limits.maxWidth} px · {limits.maxKb ? `${limits.maxKb} KB` : "keine Grenze"}
            </span>
          )}
        </button>

        {fineTuning && (
          <div className="space-y-2 pl-4">
            <Slider
              label="Maximale Breite"
              {...WIDTH_RANGE}
              value={limits.maxWidth}
              display={`${limits.maxWidth} px`}
              disabled={busy}
              onChange={(maxWidth) => updateLimits({ ...limits, maxWidth })}
            />
            <Slider
              label="Maximale Dateigröße"
              min={SIZE_RANGE.min}
              max={NO_LIMIT_POSITION}
              step={SIZE_RANGE.step}
              value={limits.maxKb ?? NO_LIMIT_POSITION}
              display={limits.maxKb ? `${limits.maxKb} KB` : "keine Grenze"}
              disabled={busy}
              onChange={(v) => updateLimits({ ...limits, maxKb: v > SIZE_RANGE.max ? null : v })}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 font-medium text-muted">Zielordner</span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={preview.outputDir}>
            {shortPath(preview.outputDir)}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted">
            {customDir ? shortPath(customDir) : "Neben den Originalen"}
          </span>
        )}
        <button onClick={pickFolder} disabled={busy} className="btn-quiet">
          Ändern…
        </button>
        {customDir && (
          <button onClick={resetFolder} disabled={busy} className="btn-quiet">
            Standard
          </button>
        )}
      </div>

      {phase.kind === "failed" && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/50 dark:text-red-200">
          {phase.message}
        </p>
      )}

      <button
        onClick={run}
        disabled={images.length === 0 || busy}
        className="relative overflow-hidden rounded-lg bg-accent py-2.5 text-sm font-semibold text-white shadow-sm transition-[filter] hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:hover:brightness-100"
      >
        {phase.kind === "processing" && (
          <span
            className="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-300"
            style={{ width: `${(phase.done / phase.total) * 100}%` }}
          />
        )}
        <span className="relative">
          {phase.kind === "processing" ? `Verarbeite… ${phase.done} / ${phase.total}` : "Verarbeiten"}
        </span>
      </button>
    </main>
  );
}

function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid grid-cols-[8.5rem_1fr_5.5rem] items-center gap-3 text-xs">
      <span className="text-muted">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
      <span className="text-right font-medium tabular-nums">{props.display}</span>
    </label>
  );
}

function DropArea(props: {
  images: ImageInfo[];
  preview: OutputPreview | null;
  dragging: boolean;
  disabled: boolean;
  onPick: () => void;
  onRemove: (path: string) => void;
}) {
  const { images, preview, dragging, disabled } = props;
  const frame = `min-h-0 flex-1 rounded-xl border-2 border-dashed transition-colors ${
    dragging ? "border-accent bg-accent/8" : "border-line"
  }`;

  if (images.length === 0) {
    return (
      <button
        onClick={props.onPick}
        disabled={disabled}
        className={`${frame} flex flex-col items-center justify-center gap-1.5 text-center hover:border-accent/60`}
      >
        <span className="text-sm font-medium">Bilder hier ablegen</span>
        <span className="text-xs text-muted">JPG, PNG, HEIC, TIFF – oder klicken zum Auswählen</span>
      </button>
    );
  }

  return (
    <div className={`${frame} flex flex-col`}>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {images.map((img, i) => {
          const plan = preview?.items[i];
          return (
            <li key={img.path} className="group flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm">{img.name}</span>
                  <span className="shrink-0 text-[11px] text-faint tabular-nums">
                    {img.width} × {img.height}
                  </span>
                </div>
                {plan && (
                  <div className="truncate font-mono text-[11px] text-muted">
                    → {plan.fileName}{" "}
                    <span className="text-accent">
                      {plan.width} × {plan.height}
                    </span>
                  </div>
                )}
              </div>
              <button
                onClick={() => props.onRemove(img.path)}
                disabled={disabled}
                aria-label={`${img.name} entfernen`}
                className="rounded px-1.5 text-lg leading-none text-faint opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <button
        onClick={props.onPick}
        disabled={disabled}
        className="border-t border-line py-1.5 text-xs text-muted hover:text-fg"
      >
        {images.length} {images.length === 1 ? "Bild" : "Bilder"} · weitere ablegen oder hinzufügen
      </button>
    </div>
  );
}

function Results(props: {
  result: BatchResult;
  limits: Limits;
  shortPath: (p: string) => string;
  onStartOver: () => void;
}) {
  const { result, limits } = props;
  const files = result.images.flatMap((i) => (i.output ? [i.output] : []));
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  const failed = result.images.filter((i) => i.error).length;
  const missed = files.filter((f) => f.limitMissed).length;
  const lowered = files.filter((f) => !f.limitMissed && f.quality < 80).length;

  return (
    <>
      <div>
        <h1 className="text-base font-semibold">{failed ? "Fertig, mit Fehlern" : "Fertig"}</h1>
        <p className="text-xs text-muted">
          {files.length} {files.length === 1 ? "Datei" : "Dateien"} · {kb(total)} · max. {limits.maxWidth} px
          {limits.maxKb ? ` / ${limits.maxKb} KB` : ""}
        </p>
        <p className="truncate font-mono text-[11px] text-faint" title={result.outputDir}>
          {props.shortPath(result.outputDir)}
        </p>
      </div>

      {missed > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          {missed === 1 ? "1 Datei ist" : `${missed} Dateien sind`} größer als {limits.maxKb} KB. Die Qualität
          wurde nicht unter 60 gesenkt, damit das Bild nicht matschig wird.
        </p>
      )}

      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {result.images.map((img) => (
          <li key={img.source} className="px-3 py-2">
            {img.output ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-mono text-xs">{img.output.fileName}</span>
                  <QualityBadge quality={img.output.quality} missed={img.output.limitMissed} />
                </div>
                <div className="flex justify-between gap-3 text-[11px] text-muted tabular-nums">
                  <span className="truncate">{img.source.split("/").pop()}</span>
                  <span className="shrink-0">
                    {img.output.width} × {img.output.height} ·{" "}
                    <span className={img.output.limitMissed ? "font-medium text-amber-700 dark:text-amber-300" : ""}>
                      {kb(img.output.bytes)}
                    </span>
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="truncate text-xs">{img.source.split("/").pop()}</div>
                <div className="text-[11px] text-red-600 dark:text-red-400">{img.error}</div>
              </>
            )}
          </li>
        ))}
      </ul>

      {lowered > 0 && (
        <p className="-mt-2 text-[11px] text-muted">
          Farbig markiert: Qualität unter 80 gesenkt, um die Größengrenze einzuhalten.
        </p>
      )}

      <div className="flex gap-2">
        {files.length > 0 && (
          <button
            // One image: select the file. Several: select their subfolder.
            onClick={() => revealItemInDir(files.length === 1 ? files[0].path : result.outputDir)}
            className="flex-1 rounded-lg border border-line py-2.5 text-sm font-medium hover:bg-field"
          >
            Im Finder zeigen
          </button>
        )}
        <button
          onClick={props.onStartOver}
          className="flex-1 rounded-lg bg-accent py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
        >
          Neue Bilder
        </button>
      </div>
    </>
  );
}

function QualityBadge({ quality, missed }: { quality: number; missed: boolean }) {
  const tone = missed
    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
    : quality < 80
      ? "bg-accent/15 text-accent"
      : "text-faint";
  return (
    <span className={`shrink-0 rounded px-1.5 py-px text-[11px] font-medium tabular-nums ${tone}`}>
      Q{quality}
      {missed && " · Ziel verfehlt"}
    </span>
  );
}
