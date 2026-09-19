import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktopDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import PreenMark from "../components/icons/PreenMark";
import { ChevronIcon, CheckIcon, CloseIcon, FolderIcon, SlidersIcon } from "../components/icons/Glyphs";
import {
  TARGET_DESKTOP,
  TARGET_SOURCE,
  appSettings,
  emphasizePanel,
  hidePanel,
  inspectImages,
  loadPreset,
  onPanelShown,
  onProgress,
  onSettingsChanged,
  previewOutput,
  processImages,
  rememberTarget,
  resizePanel,
  savePreset,
  suggestSlug,
  targetIsUsable,
  thumbnail,
  type BatchResult,
  type ImageInfo,
  type Target,
} from "../lib/api";
import { PRESETS, SIZE_RANGE, WIDTH_RANGE, kb, presetByName, type Preset } from "../lib/presets";
import { Counting, Popover, useRamp } from "./widgets";

const IDLE_HEIGHT = 184;

// The panel's three resting looks. These live here rather than in a utility
// class because they are states of one element, and inline styles are the one
// place where their order is not up to the CSS layer sorting.
const QUIET_TILE = {
  background: "linear-gradient(180deg, rgba(255,255,255,0.78), rgba(255,255,255,0.58))",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.4), 0 26px 60px rgba(6,22,26,0.42), 0 3px 10px rgba(6,22,26,0.2)",
  transition: "background 160ms ease-out, box-shadow 160ms ease-out",
};
const HOVER_TILE = {
  background: "linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.66))",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.4), 0 32px 70px rgba(6,22,26,0.5), 0 4px 12px rgba(6,22,26,0.24)",
  transition: "background 160ms ease-out, box-shadow 160ms ease-out",
};
const DROP_TILE = {
  background: "linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.66))",
  boxShadow:
    "inset 0 0 0 2px var(--color-accent), inset 0 1px 0 rgba(255,255,255,0.95), 0 32px 70px rgba(6,22,26,0.5), 0 4px 12px rgba(6,22,26,0.24)",
  transition:
    "background 180ms cubic-bezier(0.22,1,0.36,1), box-shadow 180ms cubic-bezier(0.22,1,0.36,1)",
};

type Phase =
  | { kind: "idle" }
  | { kind: "loaded" }
  | { kind: "processing"; done: number; total: number }
  | { kind: "done"; result: BatchResult; maxKb: number | null; sourceBytes: number }
  | { kind: "failed"; message: string };

/** Width and size limit for this run: the preset, with per-run overrides. */
interface Limits {
  maxWidth: number;
  maxKb: number;
  overridden: boolean;
}

export default function Panel() {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [width, setWidth] = useState(PRESETS[0].maxWidth);
  const [maxKb, setMaxKb] = useState(PRESETS[0].maxKb);
  const [target, setTarget] = useState<Target>(TARGET_SOURCE);
  const [recent, setRecent] = useState<string[]>([]);
  const [targetNote, setTargetNote] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [popover, setPopover] = useState<null | "target" | "fine">(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [autoHideSeconds, setAutoHideSeconds] = useState(0);
  // Bumped by anything that counts as "the user is here".
  const [activity, setActivity] = useState(0);

  const slugInput = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const grewOnce = useRef(false);
  const busy = phase.kind === "processing";
  const busyRef = useRef(false);
  busyRef.current = busy;

  const limits: Limits = {
    maxWidth: width,
    maxKb,
    overridden: width !== preset.maxWidth || maxKb !== preset.maxKb,
  };
  const loaded = images.length > 0;

  // ---- settings ----------------------------------------------------------
  useEffect(() => {
    (async () => {
      const [stored, presetName] = await Promise.all([appSettings(), loadPreset()]);
      const p = presetByName(presetName);
      setPreset(p);
      setWidth(p.maxWidth);
      setMaxKb(p.maxKb);
      setRecent(stored.recentTargets);
      setAutoHideSeconds(stored.autoHideSeconds);
      // A saved folder that has gone missing must not break a run.
      if (
        stored.defaultTarget !== TARGET_SOURCE &&
        stored.defaultTarget !== TARGET_DESKTOP &&
        !(await targetIsUsable(stored.defaultTarget))
      ) {
        setTarget(TARGET_SOURCE);
        setTargetNote("Der gespeicherte Ordner ist nicht mehr erreichbar.");
      } else {
        setTarget(stored.defaultTarget);
      }
    })();
  }, []);

  // ---- files -------------------------------------------------------------
  const addPaths = useCallback(async (paths: string[]) => {
    if (busyRef.current || paths.length === 0) return;
    const { images: found } = await inspectImages(paths);
    if (found.length === 0) return;
    setPhase({ kind: "loaded" });
    setImages((current) => {
      const seen = new Set(current.map((i) => i.path));
      return [...current, ...found.filter((i) => !seen.has(i.path))];
    });
  }, []);

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
    return () => void unlisten.then((f) => f());
  }, [addPaths]);

  useEffect(() => {
    const unlisten = onProgress(({ done, total }) =>
      setPhase((p) => (p.kind === "processing" ? { kind: "processing", done, total } : p)),
    );
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    const unlisten = onPanelShown(() => {
      setHovered(false);
      setActivity((n) => n + 1);
      slugInput.current?.focus();
    });
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    const unlisten = onSettingsChanged(() =>
      appSettings().then((s) => setAutoHideSeconds(s.autoHideSeconds)),
    );
    return () => void unlisten.then((f) => f());
  }, []);

  // Hide the resting panel again after a while, so a panel summoned by
  // accident doesn't sit on the screen all day. It never runs once an image is
  // loaded — nobody wants it gone while they think about the file name — and
  // not while the pointer rests on it.
  useEffect(() => {
    if (phase.kind !== "idle" || autoHideSeconds <= 0 || hovered || dragging) return;
    const timer = setTimeout(() => hidePanel(), autoHideSeconds * 1000);
    return () => clearTimeout(timer);
  }, [phase.kind, autoHideSeconds, hovered, dragging, activity]);

  // Clicks and keys count as presence too.
  useEffect(() => {
    const bump = () => setActivity((n) => n + 1);
    window.addEventListener("keydown", bump);
    window.addEventListener("mousedown", bump);
    return () => {
      window.removeEventListener("keydown", bump);
      window.removeEventListener("mousedown", bump);
    };
  }, []);

  // Preview thumbnail of the first image.
  useEffect(() => {
    const first = images[0];
    if (!first) {
      setPreview(null);
      return;
    }
    let stale = false;
    thumbnail(first.path, 60).then((url) => !stale && setPreview(url));
    return () => {
      stale = true;
    };
  }, [images]);

  // The file name follows the first original until edited by hand.
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

  // ---- target ------------------------------------------------------------
  const resolveTarget = useCallback(async (): Promise<string | null> => {
    if (target === TARGET_SOURCE) return null;
    if (target === TARGET_DESKTOP) return await desktopDir();
    return target;
  }, [target]);

  // Where the files will land, for the subfolder line.
  useEffect(() => {
    if (!loaded) {
      setOutputDir(null);
      return;
    }
    let stale = false;
    (async () => {
      const custom = await resolveTarget();
      const result = await previewOutput({
        slug,
        firstImage: images[0].path,
        sizes: images.map((i) => [i.width, i.height] as [number, number]),
        maxWidth: limits.maxWidth,
        customOutputDir: custom,
      });
      if (!stale) setOutputDir(result.outputDir);
    })();
    return () => {
      stale = true;
    };
  }, [images, slug, limits.maxWidth, resolveTarget, loaded]);

  const chooseFolder = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") {
      setTarget(dir);
      setRecent((r) => [dir, ...r.filter((p) => p !== dir)].slice(0, 3));
      rememberTarget(dir);
    }
    setPopover(null);
  };

  const pickPreset = (p: Preset) => {
    setPreset(p);
    setWidth(p.maxWidth);
    setMaxKb(p.maxKb);
    savePreset(p.name);
  };

  // ---- run ---------------------------------------------------------------
  const run = async () => {
    if (!loaded || busy) return;
    setPopover(null);
    setPhase({ kind: "processing", done: 0, total: images.length });
    try {
      const custom = await resolveTarget();
      const result = await processImages({
        paths: images.map((i) => i.path),
        slug,
        customOutputDir: custom,
        maxWidth: limits.maxWidth,
        maxKb: limits.maxKb,
      });
      const sourceBytes = images.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
      setPhase({ kind: "done", result, maxKb: limits.maxKb, sourceBytes });
    } catch (e) {
      setPhase({ kind: "failed", message: String(e) });
    }
  };

  const startOver = () => {
    setImages([]);
    setPreview(null);
    setSlugTouched(false);
    setSlug("");
    setWidth(preset.maxWidth);
    setMaxKb(preset.maxKb);
    setPopover(null);
    grewOnce.current = false;
    setPhase({ kind: "idle" });
  };

  // Only a file hovering over the panel grows it. Plain mouse-over must not:
  // a window that resizes mid-drag loses the grip point, and the panel then
  // jumps away from the pointer.
  useEffect(() => {
    if (phase.kind !== "idle") return;
    emphasizePanel(dragging ? 1.06 : 1);
  }, [dragging, phase.kind]);

  // ---- window size -------------------------------------------------------
  useLayoutEffect(() => {
    if (phase.kind === "idle") {
      grewOnce.current = false;
      resizePanel(IDLE_HEIGHT, false, false);
      return;
    }
    const element = content.current;
    if (!element) return;
    const report = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      // Only the drop itself animates; later height changes snap.
      const animate = !grewOnce.current;
      grewOnce.current = true;
      resizePanel(height, true, animate);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [phase.kind]);

  // ---- keyboard ----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (popover) setPopover(null);
      else hidePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popover]);

  const radius = loaded || phase.kind !== "idle" ? 34 : 42;

  return (
    <div
      // "deep": the whole panel is a drag handle, except buttons and fields,
      // which Tauri excludes on its own.
      data-tauri-drag-region="deep"
      className="group relative h-full"
      style={{
        borderRadius: radius,
        ...(dragging ? DROP_TILE : hovered ? HOVER_TILE : QUIET_TILE),
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDownCapture={() => popover && setPopover(null)}
    >
      {phase.kind === "idle" ? (
        <div className="flex h-full flex-col items-center justify-center">
          <PreenMark
            size={40}
            height={47}
            style={{
              transform: dragging ? "scale(1.15)" : "scale(1)",
              color: dragging ? "var(--color-accent)" : "var(--color-feather)",
              transition:
                "transform 180ms cubic-bezier(0.22,1,0.36,1), color 180ms ease-out",
            }}
          />
          <p className="mt-3 text-[12px] text-[var(--color-ink-2)]">
            {dragging ? "Loslassen" : "Bild hierher ziehen"}
          </p>
        </div>
      ) : (
        <div ref={content} className="content-in flex flex-col gap-[14px] p-4">
          {phase.kind === "done" ? (
            <Done
              result={phase.result}
              maxKb={phase.maxKb}
              sourceBytes={phase.sourceBytes}
              preview={preview}
              onStartOver={startOver}
            />
          ) : (
            <>
              <Header
                images={images}
                preview={preview}
                onRemove={startOver}
                disabled={busy}
              />
              <div className="hairline" />

              <div>
                <div
                  data-tauri-drag-region="false"
                  className="grid grid-cols-2 gap-1 rounded-[15px] p-1"
                  style={{ background: "var(--color-quieter)" }}
                  role="radiogroup"
                  aria-label="Voreinstellung"
                >
                  {PRESETS.map((p) => {
                    const active = p.name === preset.name;
                    return (
                      <button
                        key={p.name}
                        role="radio"
                        aria-checked={active}
                        disabled={busy}
                        onClick={() => pickPreset(p)}
                        className={`h-9 rounded-xl text-[13px] font-semibold ${
                          active
                            ? "bg-white text-[var(--color-ink)] shadow-[0_1px_3px_rgba(6,22,26,0.14)]"
                            : "text-[var(--color-ink-2)]"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-center text-[11px] text-[var(--color-ink-3)] tabular-nums">
                  {limits.maxWidth} px · max. {limits.maxKb} KB
                  {limits.overridden && " (angepasst)"}
                </p>
              </div>

              <div>
                <label htmlFor="slug" className="label-caps">
                  Dateiname
                </label>
                <div
                  data-tauri-drag-region="false"
                  className="mt-1.5 flex h-11 items-center rounded-[14px] bg-white/70 px-3 shadow-[inset_0_0_0_1px_var(--color-hairline)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-accent)]">
                  <input
                    id="slug"
                    ref={slugInput}
                    value={slug}
                    disabled={busy}
                    spellCheck={false}
                    autoFocus
                    onChange={(e) => {
                      setSlug(e.target.value);
                      setSlugTouched(true);
                    }}
                    onBlur={async () => {
                      if (!slug.trim()) setSlugTouched(false);
                      else setSlug(await suggestSlug(slug));
                    }}
                    onKeyDown={(e) => e.key === "Enter" && run()}
                    className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                  />
                  <span className="pl-1 text-[13px] text-[var(--color-ink-3)]">
                    {images.length > 1 ? `-1 … -${images.length}.webp` : ".webp"}
                  </span>
                </div>
              </div>

              <div className="relative">
                <div className="flex gap-2">
                  <ChooserButton
                    icon={<FolderIcon />}
                    value={targetLabel(target)}
                    active={popover === "target"}
                    disabled={busy}
                    onClick={() => setPopover(popover === "target" ? null : "target")}
                  />
                  <ChooserButton
                    icon={<SlidersIcon />}
                    value="Fein"
                    dot={limits.overridden}
                    active={popover === "fine"}
                    disabled={busy}
                    onClick={() => setPopover(popover === "fine" ? null : "fine")}
                  />
                </div>

                {images.length > 1 && outputDir && (
                  <p className="mt-1.5 text-[11px] text-[var(--color-ink-3)]">
                    Unterordner{" "}
                    <span className="font-semibold text-[var(--color-ink-2)]">
                      {outputDir.split("/").pop()}
                    </span>
                  </p>
                )}

                {popover === "target" && (
                  <Popover width={224} align="left">
                    {targetNote && (
                      <p className="px-3 pt-2 text-[11px] text-[var(--color-ink-3)]">{targetNote}</p>
                    )}
                    <TargetItem
                      label="Quellordner"
                      active={target === TARGET_SOURCE}
                      onClick={() => {
                        setTarget(TARGET_SOURCE);
                        setPopover(null);
                      }}
                    />
                    <TargetItem
                      label="Schreibtisch"
                      active={target === TARGET_DESKTOP}
                      onClick={() => {
                        setTarget(TARGET_DESKTOP);
                        setPopover(null);
                      }}
                    />
                    {recent.map((path) => (
                      <TargetItem
                        key={path}
                        label={path.split("/").pop() ?? path}
                        hint="zuletzt"
                        active={target === path}
                        onClick={() => {
                          setTarget(path);
                          setPopover(null);
                        }}
                      />
                    ))}
                    <div className="my-1 hairline" />
                    <TargetItem label="Anderen Ordner wählen …" onClick={chooseFolder} />
                  </Popover>
                )}

                {popover === "fine" && (
                  <Popover width={232} align="right">
                    <div className="space-y-3 p-3">
                      <Slider
                        label="Breite"
                        unit="px"
                        {...WIDTH_RANGE}
                        value={limits.maxWidth}
                        onChange={setWidth}
                      />
                      <Slider
                        label="Obergrenze"
                        unit="KB"
                        {...SIZE_RANGE}
                        value={limits.maxKb}
                        onChange={setMaxKb}
                      />
                      <div className="hairline" />
                      <button
                        onClick={() => {
                          setWidth(preset.maxWidth);
                          setMaxKb(preset.maxKb);
                        }}
                        className="w-full text-left text-[12px] font-semibold text-[var(--color-accent)]"
                      >
                        Auf {preset.label} zurücksetzen
                      </button>
                    </div>
                  </Popover>
                )}
              </div>

              {phase.kind === "failed" && (
                <p className="rounded-xl bg-[rgba(176,58,46,0.1)] px-3 py-2 text-[11px] text-[#8c2f26]">
                  {phase.message}
                </p>
              )}

              <button
                onClick={run}
                disabled={busy}
                className="relative h-[46px] overflow-hidden rounded-2xl bg-[var(--color-accent)] text-[14px] font-semibold text-white disabled:opacity-80"
              >
                {busy && (
                  <span
                    className="absolute inset-y-0 left-0 bg-white/20"
                    style={{ width: `${(phase.done / phase.total) * 100}%` }}
                  />
                )}
                <span className="relative">
                  {busy ? `Verarbeite… ${phase.done} / ${phase.total}` : "Verarbeiten"}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function targetLabel(target: Target) {
  if (target === TARGET_SOURCE) return "Quellordner";
  if (target === TARGET_DESKTOP) return "Schreibtisch";
  return target.split("/").pop() ?? target;
}

function Header(props: {
  images: ImageInfo[];
  preview: string | null;
  onRemove: () => void;
  disabled: boolean;
}) {
  const { images, preview } = props;
  const many = images.length > 1;
  const first = images[0];
  const totalBytes = images.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
  return (
    <div className="flex items-center gap-3">
      <Thumb src={preview} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold">
          {many ? `${images.length} Bilder` : first.name}
        </p>
        <p className="text-[11px] text-[var(--color-ink-2)] tabular-nums">
          {many ? `zusammen ${kb(totalBytes)}` : `${first.width} × ${first.height} · ${kb(first.bytes ?? 0)}`}
        </p>
      </div>
      <button
        onClick={props.onRemove}
        disabled={props.disabled}
        aria-label="Bilder entfernen"
        className="grid size-7 place-items-center rounded-full text-[var(--color-ink-3)]"
        style={{ background: "var(--color-quiet)" }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function Thumb({ src, badge }: { src: string | null; badge?: boolean }) {
  return (
    <div className="relative shrink-0">
      <div
        className="size-[60px] overflow-hidden rounded-[18px] bg-white/60 shadow-[inset_0_0_0_1px_var(--color-hairline)]"
      >
        {src && <img src={src} alt="" className="size-full object-cover" />}
      </div>
      {badge && (
        <span className="check-in absolute -right-1 -bottom-1 grid size-6 place-items-center rounded-full bg-[var(--color-accent)] text-white ring-[3px] ring-white">
          <CheckIcon size={12} />
        </span>
      )}
    </div>
  );
}

function ChooserButton(props: {
  icon: React.ReactNode;
  value: string;
  dot?: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      disabled={props.disabled}
      aria-expanded={props.active}
      className="flex h-[38px] min-w-0 flex-1 items-center gap-1.5 rounded-[13px] px-2.5 text-[var(--color-ink-2)]"
      style={{ background: "var(--color-quiet)" }}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate text-right text-[12px] font-semibold text-[var(--color-ink)]">
        {props.value}
      </span>
      {props.dot && <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />}
      <ChevronIcon className="shrink-0" />
    </button>
  );
}

function TargetItem(props: { label: string; hint?: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      className="flex w-full items-center gap-2 rounded-[10px] px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-quiet)]"
    >
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.hint && <span className="text-[10px] text-[var(--color-ink-3)]">{props.hint}</span>}
      {props.active && <CheckIcon size={12} className="text-[var(--color-accent)]" />}
    </button>
  );
}

function Slider(props: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const filled = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-[var(--color-ink-2)]">{props.label}</span>
        <span className="text-[12px] font-semibold tabular-nums">
          {props.value} {props.unit}
        </span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{
          ["--range-track" as string]: `linear-gradient(90deg, var(--color-accent) ${filled}%, rgba(15,44,43,0.16) ${filled}%)`,
        }}
      />
    </div>
  );
}

function Done(props: {
  result: BatchResult;
  maxKb: number | null;
  sourceBytes: number;
  preview: string | null;
  onStartOver: () => void;
}) {
  const { result, maxKb } = props;
  const files = result.images.flatMap((i) => (i.output ? [i.output] : []));
  const failed = result.images.filter((i) => i.error);
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const limitBytes = maxKb ? maxKb * 1000 * files.length : null;
  const used = limitBytes ? Math.min(100, (bytes / limitBytes) * 100) : 100;
  const first = files[0];
  const many = files.length > 1;
  // The number and the bar share one ramp so they arrive together.
  const ramp = useRamp();
  const quality = useMemo(() => {
    const qualities = [...new Set(files.map((f) => f.quality))];
    return qualities.length === 1 ? `Q${qualities[0]}` : `Q${Math.min(...qualities)}–${Math.max(...qualities)}`;
  }, [files]);

  return (
    <>
      <div className="flex items-center gap-3">
        <Thumb src={props.preview} badge />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">
            {many ? `${files.length} Dateien` : first?.fileName}
          </p>
          <p className="text-[11px] text-[var(--color-ink-2)] tabular-nums">
            {first && `${first.width} × ${first.height} · ${quality}`}
          </p>
        </div>
      </div>

      <div className="rounded-[20px] bg-white/[0.62] p-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[27px] leading-none font-semibold tabular-nums">
            <Counting value={(bytes / 1000) * ramp} digits={bytes < 10000 ? 1 : 0} />
          </span>
          <span className="text-[11px] text-[var(--color-ink-3)]">KB</span>
          <span className="ml-auto text-[11px] text-[var(--color-ink-3)]">
            aus {kb(props.sourceBytes)}
          </span>
        </div>
        <div className="mt-2.5 h-[7px] overflow-hidden rounded-full bg-[rgba(15,44,43,0.1)]">
          <div
            className="h-full rounded-full bg-[var(--color-accent)]"
            style={{ width: `${used * ramp}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-[var(--color-ink-3)] tabular-nums">
          <span>
            <Counting value={used * ramp} digits={0} /> % genutzt
          </span>
          <span>{maxKb ? `Grenze ${maxKb} KB` : "ohne Grenze"}</span>
        </div>
      </div>

      {failed.length > 0 && (
        <p className="text-[11px] text-[#8c2f26]">
          {failed.length === 1 ? "1 Bild" : `${failed.length} Bilder`} konnten nicht verarbeitet werden.
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => first && revealItemInDir(many ? result.outputDir : first.path)}
          className="h-11 flex-1 rounded-[14px] bg-white/70 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--color-hairline)]"
        >
          Im Finder zeigen
        </button>
        <button
          onClick={props.onStartOver}
          className="h-11 flex-1 rounded-[14px] bg-[var(--color-accent)] text-[13px] font-semibold text-white"
        >
          Noch eins
        </button>
      </div>
    </>
  );
}
