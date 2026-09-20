import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Switch } from "../components/Switch";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktopDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import PreenMark from "../components/icons/PreenMark";
import {
  BangIcon,
  ChevronIcon,
  CheckIcon,
  FolderIcon,
  SlidersIcon,
} from "../components/icons/Glyphs";
import {
  TARGET_DESKTOP,
  TARGET_SOURCE,
  appSettings,
  hidePanel,
  inspectImages,
  loadPreset,
  onForgetImages,
  onOpenFiles,
  onPanelShown,
  onProgress,
  onSettingsChanged,
  previewOutput,
  processImages,
  rememberTarget,
  resizePanel,
  debugLog,
  savePreset,
  suggestName,
  suggestSlug,
  targetIsUsable,
  thumbnail,
  type BatchResult,
  type ImageResult,
  type Rejected,
  type ImageInfo,
  type Target,
} from "../lib/api";
import {
  EDGE_RANGE,
  PRESETS,
  SIZE_RANGE,
  kb,
  mp,
  presetByName,
  type Preset,
} from "../lib/presets";
import { Popover } from "../components/Popover";
import { Counting, Swap, reducedMotion, useRamp } from "./widgets";

/** Panel width once an image is loaded; matches LOADED_WIDTH in panel.rs. */
const LOADED_WIDTH = 340;
/**
 * The panel's four heights, and the only place they are written down.
 * Layout and spacing come from design/panel-reference.html; these numbers are
 * what that layout measures in the app, with the system font.
 *
 * Measuring at runtime instead meant measuring mid-animation and mid-wrap, and
 * the window ended up shorter than the card. Nothing else may change the
 * height: a file hovering over the panel only lights a ring (see DROP_RING).
 */
// Gemessen im Debug-Build, nicht gerechnet: neben das 60 px hohe
// Vorschaubild passen drei Textzeilen ohne dass etwas wächst. Die vierte —
// der zweite Fehlschlag mit Namen und Grund — kostet 16 px, und die stehen
// hier. Nach jeder Layoutänderung neu nachsehen, was die Zusicherung sagt.
const HEIGHTS = { idle: 184, one: 381, many: 403, done: 258, doneErrors: 274 };
/** How long the panel takes to open after a drop. */
const GROW_MS = 480;
/** ... and to fold back up. */
const SHRINK_MS = 380;

// The panel's three resting looks, from design/panel-reference.html. Hovering
// does not change the surface, it lights an inner ring — the zero-alpha ring
// in the resting state is what the transition interpolates from.
const TILE_SURFACE =
  "linear-gradient(180deg, rgba(255,255,255,0.82) 0%, rgba(228,239,237,0.60) 100%)";
const TILE_BASE =
  "0 26px 60px rgba(6,22,26,0.42), 0 3px 10px rgba(6,22,26,0.2), inset 0 1px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.4)";
const tile = (ring: string, glow: string) => ({
  background: TILE_SURFACE,
  boxShadow: `${TILE_BASE}, inset 0 0 0 1.5px rgba(46,109,99,${ring}), inset 0 0 30px -6px rgba(46,109,99,${glow})`,
  transition: "box-shadow 240ms var(--ease-ui)",
});
const QUIET_TILE = tile("0", "0");
const HOVER_TILE = tile("0.45", "0.32");
/** A file hovering over the panel lights this ring — an overlay, so no state
 *  change can alter the layout height. */
const DROP_RING =
  "inset 0 0 0 1.5px rgba(46,109,99,0.9), inset 0 0 30px -6px rgba(46,109,99,0.5)";

type Phase =
  | { kind: "idle" }
  | { kind: "loaded" }
  | { kind: "processing"; done: number; total: number }
  | { kind: "done"; result: BatchResult; maxKb: number | null; sourceBytes: number }
  | { kind: "failed"; message: string };

/** Size limits for this run: the preset, with per-run overrides. */
interface Limits {
  longEdge: number;
  maxMegapixels: number;
  minLongEdge: number;
  maxKb: number;
  overwrite: boolean;
  overridden: boolean;
}

export default function Panel() {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [longEdge, setLongEdge] = useState(PRESETS[0].longEdge);
  const [maxKb, setMaxKb] = useState(PRESETS[0].maxKb);
  // Destructive, so it never carries over: off again for every new drop.
  const [overwrite, setOverwrite] = useState(false);
  const [target, setTarget] = useState<Target>(TARGET_SOURCE);
  const [recent, setRecent] = useState<string[]>([]);
  const [targetNote, setTargetNote] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [popover, setPopover] = useState<null | "target" | "fine">(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [autoHideSeconds, setAutoHideSeconds] = useState(0);
  // Beim Ablegen aussortierte Dateien. Steht, bis der Nutzer etwas tut —
  // nichts verschwindet lautlos, und kein Timer, den man verpassen kann.
  const [rejected, setRejected] = useState<Rejected[]>([]);
  // Bumped by anything that counts as "the user is here".
  const [activity, setActivity] = useState(0);

  const slugInput = useRef<HTMLInputElement>(null);
  const grewOnce = useRef(false);
  /** For the handler that runs when the panel is summoned again. */
  const heightRef = useRef(HEIGHTS.idle);
  const phaseRef = useRef("idle");
  const busy = phase.kind === "processing";
  const busyRef = useRef(false);
  busyRef.current = busy;

  const limits: Limits = {
    longEdge,
    // Pixel cap and emergency floor belong to the preset; the fine controls
    // do not touch them.
    maxMegapixels: preset.maxMegapixels,
    minLongEdge: preset.minLongEdge,
    maxKb,
    overwrite,
    overridden: longEdge !== preset.longEdge || maxKb !== preset.maxKb || overwrite,
  };
  const loaded = images.length > 0;

  // ---- settings ----------------------------------------------------------
  useEffect(() => {
    (async () => {
      const [stored, presetName] = await Promise.all([appSettings(), loadPreset()]);
      const p = presetByName(presetName);
      setPreset(p);
      setLongEdge(p.longEdge);
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
    const { images: found, rejected: turnedDown } = await inspectImages(paths);
    setRejected(turnedDown);
    // Auch wenn nichts übrig bleibt: die Ruhe-Ansicht sagt dann, was weg ist.
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
    const unlisten = onOpenFiles((paths) => addPaths(paths));
    return () => void unlisten.then((f) => f());
  }, [addPaths]);

  useEffect(() => {
    const unlisten = onPanelShown(() => {
      setHovered(false);
      setActivity((n) => n + 1);
      setRejected([]);
      slugInput.current?.focus({ preventScroll: true });
      // The window may have been left at a stale size; state it again.
      resizePanel(heightRef.current, phaseRef.current !== "idle", 0);
    });
    return () => void unlisten.then((f) => f());
  }, []);

  // Hidden for long enough: let go of the picture, so the next summon starts
  // clean. Never while a run is going on.
  useEffect(() => {
    const unlisten = onForgetImages(() => {
      if (phase.kind !== "processing") startOver();
    });
    return () => void unlisten.then((f) => f());
  });

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
    suggestName(suggestionSource).then((s) => !stale && setSlug(s));
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
        longEdge: limits.longEdge,
        maxMegapixels: limits.maxMegapixels,
        overwrite: limits.overwrite,
        customOutputDir: custom,
      });
      if (!stale) setOutputDir(result.outputDir);
    })();
    return () => {
      stale = true;
    };
  }, [
    images,
    slug,
    limits.longEdge,
    limits.maxMegapixels,
    limits.overwrite,
    resolveTarget,
    loaded,
  ]);

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
    setRejected([]);
    setPreset(p);
    setLongEdge(p.longEdge);
    setMaxKb(p.maxKb);
    savePreset(p.name);
  };

  // ---- run ---------------------------------------------------------------
  const run = async () => {
    if (!loaded || busy) return;
    setRejected([]);
    setPopover(null);
    setPhase({ kind: "processing", done: 0, total: images.length });
    try {
      const custom = await resolveTarget();
      const result = await processImages({
        paths: images.map((i) => i.path),
        slug,
        customOutputDir: custom,
        limits: {
          longEdge: limits.longEdge,
          maxMegapixels: limits.maxMegapixels,
          minLongEdge: limits.minLongEdge,
          maxKb: limits.maxKb,
          overwrite: limits.overwrite,
        },
      });
      const sourceBytes = images.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
      // Ohne eine einzige fertige Datei gibt es nichts zu zeigen: dann ist
      // der Lauf fehlgeschlagen und nicht "fertig".
      if (!result.images.some((i) => i.output)) {
        const first = result.images.find((i) => i.error)?.error ?? "Nichts verarbeitet";
        setPhase({
          kind: "failed",
          message: result.images.length > 1 ? `Keine der ${result.images.length} Dateien: ${first}` : first,
        });
        return;
      }
      setPhase({ kind: "done", result, maxKb: limits.maxKb, sourceBytes });
    } catch (e) {
      setPhase({ kind: "failed", message: String(e) });
    }
  };

  const startOver = () => {
    setRejected([]);
    setImages([]);
    setPreview(null);
    setSlugTouched(false);
    setSlug("");
    setLongEdge(preset.longEdge);
    setMaxKb(preset.maxKb);
    setOverwrite(false);
    setPopover(null);
    grewOnce.current = false;
    setPhase({ kind: "idle" });
  };

  // ---- window size -------------------------------------------------------
  // One height per state. The window is told what it will be, instead of
  // chasing a measurement that changes while the panel animates.
  const panelHeight =
    phase.kind === "idle"
      ? HEIGHTS.idle
      : phase.kind === "done"
        ? doneHeight(phase.result)
        : images.length > 1
          ? HEIGHTS.many
          : HEIGHTS.one;

  useLayoutEffect(() => {
    const isLoaded = phase.kind !== "idle";
    const opening = isLoaded && !grewOnce.current && !reducedMotion();
    const closing = !isLoaded && grewOnce.current && !reducedMotion();
    grewOnce.current = isLoaded;
    resizePanel(panelHeight, isLoaded, opening ? GROW_MS : closing ? SHRINK_MS : 0);

    // Debug builds only: shout when the layout and the fixed height disagree.
    if (__PREEN_DEBUG__) {
      // The card is told its height, so comparing it with itself proves
      // nothing: what matters is what the content inside actually needs.
      setTimeout(() => {
        // Der Zustand kann weitergelaufen sein, bevor gemessen wird — vier
        // kleine Bilder sind in unter 600 ms durch. Dann gälte die Messung
        // einem Layout, das es nicht mehr gibt. Lieber schweigen als falsch
        // schimpfen: eine Zusicherung, die man wegliest, ist keine.
        if (phaseRef.current !== phase.kind || heightRef.current !== panelHeight) return;
        const inner = document.getElementById("panel-content");
        const actual = inner ? inner.offsetHeight : HEIGHTS.idle;
        if (actual !== panelHeight) {
          const message = `HÖHE STIMMT NICHT · Zustand "${phase.kind}"${
            isLoaded ? ` (${images.length} Bild${images.length === 1 ? "" : "er"})` : ""
          } · soll ${panelHeight} px · ist ${actual} px`;
          console.error(`[preen] ${message}`);
          debugLog(message);
        }
      }, 600);
    }
  }, [panelHeight, phase.kind, images.length]);

  // Debug builds only: F8 stands in for a file hovering over the panel, so the
  // drop state can be looked at without dragging something from Finder.
  useEffect(() => {
    if (!__PREEN_DEBUG__) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F8") setDragging((d) => !d);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const targetOptions: { value: Target; label: string; hint?: string }[] = [
    { value: TARGET_SOURCE, label: "Quellordner" },
    { value: TARGET_DESKTOP, label: "Schreibtisch" },
    ...recent.map((path) => ({
      value: path,
      label: path.split("/").pop() ?? path,
      hint: "zuletzt",
    })),
  ];
  const activeTargetIndex = targetOptions.findIndex((o) => o.value === target);
  const loadedLayout = phase.kind !== "idle";
  const radius = loadedLayout ? 34 : 42;
  heightRef.current = panelHeight;
  phaseRef.current = phase.kind;

  return (
    <div
      // "deep": the whole panel is a drag handle, except buttons and fields,
      // which Tauri excludes on its own.
      id="panel-card"
      data-tauri-drag-region="deep"
      // `fixed` pins the card to the viewport: focusing the name field made
      // WebKit scroll the document, which pushed the header out of sight.
      // Anchored at the bottom, so any surplus goes up into the invisible.
      // The width is fixed while the window is still growing into it, or the
      // text would re-wrap at every intermediate width.
      className={`group fixed ${
        loadedLayout ? "bottom-0 left-1/2 -translate-x-1/2" : "inset-0"
      }`}
      style={{
        // The resting tile fills whatever the window is, because the window
        // itself grows a little when a file hovers over it.
        width: loadedLayout ? LOADED_WIDTH : undefined,
        height: loadedLayout ? panelHeight : undefined,
        borderRadius: radius,
        ...(hovered || dragging ? HOVER_TILE : QUIET_TILE),
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDownCapture={() => popover && setPopover(null)}
    >
      {/* Only opacity changes here; the card underneath keeps its size. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          borderRadius: radius,
          boxShadow: DROP_RING,
          opacity: dragging ? 1 : 0,
          transition: "opacity 240ms var(--ease-ui)",
        }}
      />

      {phase.kind === "idle" ? (
        <div className="flex h-full flex-col items-center justify-center gap-4">
          <PreenMark
            size={40}
            height={47}
            style={{
              transform: dragging ? "scale(1.15)" : "scale(1)",
              color: dragging ? "var(--color-accent)" : "var(--color-feather)",
              transition: "transform 180ms var(--ease-enter), color 180ms var(--ease-ui)",
            }}
          />
          {rejected.length > 0 && !dragging ? (
            <p
              className="px-5 text-center text-[12px] font-medium tracking-[0.01em] text-balance text-[var(--color-over)]"
              title={rejectionTitle(rejected)}
            >
              {rejectionLine(rejected)}
            </p>
          ) : (
            <p className="text-[12px] font-medium tracking-[0.01em] text-[#40635f]">
              {dragging ? "Loslassen" : "Bild hierher ziehen"}
            </p>
          )}
        </div>
      ) : (
        <div id="panel-content" className="content-in flex flex-col gap-[14px] p-4">
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
              <div style={{ height: 1, background: "var(--color-divider)" }} />

              <div className="flex flex-col gap-[7px]">
                <div
                  data-tauri-drag-region="false"
                  className="relative rounded-[15px] p-1"
                  style={{ background: "var(--color-quieter)" }}
                  role="radiogroup"
                  aria-label="Voreinstellung"
                >
                  {/* One body travelling between the two labels; swapping two
                      backgrounds would jump every time. */}
                  <span
                    aria-hidden
                    className="absolute top-1 bottom-1 left-1 rounded-xl bg-white shadow-[0_1px_3px_rgba(6,22,26,0.2)]"
                    style={{
                      width: "calc(50% - 6px)",
                      transform:
                        preset.name === PRESETS[0].name
                          ? "translateX(0)"
                          : "translateX(calc(100% + 4px))",
                      transition: "transform 380ms var(--ease-ui)",
                    }}
                  />
                  <div className="relative grid grid-cols-2 gap-1">
                    {PRESETS.map((p) => {
                      const active = p.name === preset.name;
                      return (
                        <button
                          key={p.name}
                          role="radio"
                          aria-checked={active}
                          disabled={busy}
                          onClick={() => pickPreset(p)}
                          className="pressable h-9 rounded-xl text-[13px]"
                          style={{
                            color: active ? "var(--color-ink)" : "var(--color-ink-2)",
                            fontWeight: active ? 700 : 500,
                            transitionProperty: "transform, color, font-weight",
                            transitionDuration: "140ms, 380ms, 380ms",
                            transitionTimingFunction:
                              "var(--ease-enter), var(--ease-ui), var(--ease-ui)",
                          }}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {phase.kind === "failed" ? (
                  <p className="truncate pl-1 text-[11px] text-[var(--color-over)]" title={phase.message}>
                    {phase.message}
                  </p>
                ) : rejected.length > 0 ? (
                  <p
                    className="truncate pl-1 text-[11px] text-[var(--color-over)]"
                    title={rejectionTitle(rejected)}
                  >
                    {rejectionLine(rejected)}
                  </p>
                ) : (
                <p className="truncate pl-1 text-[11px] text-[var(--color-ink-2)] tabular-nums">
                  <Swap
                    text={`lange Kante ${limits.longEdge} px · ${mp(limits.maxMegapixels)} · höchstens ${limits.maxKb} KB${
                      images.length > 1 ? " je Bild" : ""
                    }${limits.overridden ? " (angepasst)" : ""}`}
                    className="inline-block"
                  />
                </p>
                )}
              </div>

              <div className="flex flex-col gap-[7px]">
                <label htmlFor="slug" className="label-caps">
                  Dateiname
                </label>
                <div
                  data-tauri-drag-region="false"
                  className="flex h-11 items-center gap-1.5 rounded-[14px] bg-white/75 px-3 shadow-[inset_0_0_0_1px_var(--color-divider)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-accent)]"
                >
                  <input
                    id="slug"
                    ref={slugInput}
                    value={slug}
                    disabled={busy}
                    spellCheck={false}
                    onChange={(e) => {
                      setSlug(e.target.value);
                      setSlugTouched(true);
                    }}
                    onBlur={async () => {
                      if (!slug.trim()) setSlugTouched(false);
                      else setSlug(await suggestSlug(slug));
                    }}
                    onKeyDown={(e) => e.key === "Enter" && run()}
                    placeholder="Name eingeben"
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none placeholder:font-normal placeholder:text-[var(--color-ink-3)]"
                  />
                  <span className="shrink-0 text-[13px] font-medium text-[var(--color-ink-3)]">
                    {images.length > 1 ? `-1 … -${images.length}.webp` : ".webp"}
                  </span>
                </div>
              </div>

              <div className="relative">
                <div className="flex gap-2">
                  <ChooserButton
                    icon={<FolderIcon />}
                    value={targetLabel(target)}
                    title={targetTitle(target)}
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
                    legt darin den Ordner{" "}
                    <span className="font-semibold text-[var(--color-ink-2)]">
                      {outputDir.split("/").pop()}/
                    </span>{" "}
                    an
                  </p>
                )}

                <Popover open={popover === "target"} width={224} align="left" label="Zielort">
                  {targetNote && (
                    <p className="px-3 pt-2 text-[11px] text-[var(--color-ink-3)]">{targetNote}</p>
                  )}
                  <div className="relative">
                    {/* The selection is one pill that travels, not a highlight
                        that reappears somewhere else. */}
                    <span
                      aria-hidden
                      className="absolute inset-x-0 top-0 h-7 rounded-[10px]"
                      style={{
                        background: "var(--color-quiet)",
                        opacity: activeTargetIndex < 0 ? 0 : 1,
                        transform: `translateY(${Math.max(0, activeTargetIndex) * TARGET_ROW_HEIGHT}px)`,
                        transition:
                          "transform 280ms var(--ease-ui), opacity 160ms var(--ease-enter)",
                      }}
                    />
                    <div className="relative">
                      {targetOptions.map((option) => (
                        <TargetItem
                          key={option.value}
                          label={option.label}
                          hint={option.hint}
                          active={option.value === target}
                          onClick={() => {
                            setTarget(option.value);
                            setPopover(null);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="my-1 hairline" />
                  <TargetItem
                    label="Anderen Ordner wählen …"
                    icon={<FolderIcon size={13} className="text-[var(--color-ink-3)]" />}
                    onClick={chooseFolder}
                  />
                </Popover>

                <Popover open={popover === "fine"} width={252} align="right" label="Feineinstellung">
                  <div className="space-y-3 p-3">
                    <Slider
                      label="Lange Kante"
                      unit="px"
                      {...EDGE_RANGE}
                      value={limits.longEdge}
                      onChange={setLongEdge}
                    />
                    <Slider
                      label="Obergrenze"
                      unit="KB"
                      {...SIZE_RANGE}
                      value={limits.maxKb}
                      onChange={setMaxKb}
                    />
                    <label className="flex cursor-pointer items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-[var(--color-ink-2)]">
                        Bestehende Dateien ersetzen
                      </span>
                      <Switch
                        compact
                        checked={limits.overwrite}
                        label="Bestehende Dateien ersetzen"
                        onChange={setOverwrite}
                      />
                    </label>
                    <div className="hairline" />
                    <button
                      onClick={() => {
                        setLongEdge(preset.longEdge);
                        setMaxKb(preset.maxKb);
                        setOverwrite(false);
                      }}
                      className="pressable w-full text-left text-[12px] font-semibold text-[var(--color-accent)]"
                    >
                      Auf {preset.label} zurücksetzen
                    </button>
                  </div>
                </Popover>
              </div>

              <button
                onClick={run}
                disabled={busy}
                className="pressable relative h-[46px] overflow-hidden rounded-2xl bg-[var(--color-accent)] text-[14px] font-semibold text-white shadow-[0_4px_12px_rgba(6,22,26,0.22)] disabled:opacity-80"
              >
                {busy && (
                  <span
                    className="absolute inset-y-0 left-0 bg-white/20"
                    style={{ width: `${(phase.done / phase.total) * 100}%` }}
                  />
                )}
                <span className="relative">
                  {busy
                    ? `Verarbeite… ${phase.done} / ${phase.total}`
                    : images.length > 1
                      ? `${images.length} Bilder verarbeiten`
                      : "Verarbeiten"}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Every row in the target menu is this tall, so the pill can simply travel. */
const TARGET_ROW_HEIGHT = 28;

/** The full path behind an abbreviated folder name. */
function targetTitle(target: Target) {
  if (target === TARGET_SOURCE) return "Neben dem Original";
  if (target === TARGET_DESKTOP) return "Schreibtisch";
  return target;
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
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="truncate text-[13px] font-semibold">
          {many ? `${images.length} Bilder` : first.name}
        </p>
        <p className="text-[11px] text-[var(--color-ink-2)] tabular-nums">
          {many
            ? `zusammen ${kb(totalBytes)}`
            : `${first.width} × ${first.height} px · ${kb(first.bytes ?? 0)}`}
        </p>
      </div>
      <button
        onClick={props.onRemove}
        disabled={props.disabled}
        aria-label="Bilder entfernen"
        className="pressable grid size-7 shrink-0 place-items-center rounded-full text-[14px] leading-none text-[#40635f]"
        style={{ background: "rgba(15,44,43,0.08)" }}
      >
        ×
      </button>
    </div>
  );
}

const sourceName = (path: string) => path.split("/").pop() ?? path;

/**
 * What was turned down at the drop, in one line. The panel filters before it
 * loads anything, which is right — but then it has to say so, or files
 * disappear without a word.
 *
 * One file gets its reason; several get their names, because in 340 px the
 * names are what lets you go and look. The reasons are in the tooltip, and
 * the line is never the only place the information exists.
 */
function rejectionLine(rejected: Rejected[]): string {
  if (rejected.length === 1) return `${rejected[0].name} — ${rejected[0].reason}`;
  return `${rejected.length} nicht angenommen: ${rejected.map((r) => r.name).join(", ")}`;
}

const rejectionTitle = (rejected: Rejected[]) =>
  rejected.map((r) => `${r.name} — ${r.reason}`).join("\n");

/**
 * One line for what did not work. Up to two files are named with their
 * reason; beyond that a collected line, because the third would push the
 * panel past its fixed height. The full list is in the tooltip.
 */
/**
 * What did not work, in at most two lines.
 *
 * One or two files are named with their reason — that is what the extra
 * 16 px of `doneErrors` are for. From three on the count and the reason lead,
 * but the names still stand on the second line: a collected line whose
 * content only lives in a tooltip is a hiding place.
 */
function failureLines(failed: ImageResult[]): string[] {
  const entry = (f: ImageResult) => `${sourceName(f.source)} — ${f.error}`;
  if (failed.length <= 2) return failed.map(entry);
  const reasons = [...new Set(failed.map((f) => f.error))];
  const head =
    reasons.length === 1
      ? `${failed.length} nicht verarbeitet — ${reasons[0]}`
      : `${failed.length} nicht verarbeitet`;
  return [head, failed.map((f) => sourceName(f.source)).join(", ")];
}

/** Failures need a second line as soon as there are two of them. */
function doneHeight(result: BatchResult): number {
  return result.images.filter((i) => i.error).length >= 2 ? HEIGHTS.doneErrors : HEIGHTS.done;
}

function Thumb({
  src,
  badge,
  over,
}: {
  src: string | null;
  badge?: boolean;
  /** Over the size limit: the badge keeps its shape and says so. */
  over?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <div className="size-[60px] overflow-hidden rounded-[18px] bg-white/60 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.5)]">
        {src && <img src={src} alt="" className="size-full object-cover" />}
      </div>
      {badge && (
        <span
          className="check-in absolute -right-1 -bottom-1 grid size-6 place-items-center rounded-full text-white"
          style={{
            boxShadow: "0 0 0 3px rgba(255,255,255,0.85)",
            background: over ? "var(--color-over)" : "var(--color-accent)",
          }}
        >
          {over ? (
            <BangIcon size={12} strokeWidth={2.4} />
          ) : (
            <CheckIcon size={12} strokeWidth={2.4} />
          )}
        </span>
      )}
    </div>
  );
}

function ChooserButton(props: {
  icon: React.ReactNode;
  value: string;
  /** Shown on hover — the folder name alone cannot carry a whole path. */
  title?: string;
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
      title={props.title}
      aria-expanded={props.active}
      className="pressable flex h-[38px] min-w-0 flex-1 items-center gap-[7px] rounded-[13px] pr-2 pl-2.5 text-left"
      style={{ background: "var(--color-quiet)" }}
    >
      <span className="shrink-0 text-[var(--color-accent)]">{props.icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-ink)]">
        {props.value}
      </span>
      {props.dot && <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />}
      <ChevronIcon className="shrink-0" />
    </button>
  );
}

function TargetItem(props: {
  label: string;
  hint?: string;
  active?: boolean;
  /** Shown in place of the check mark, for the row that opens a dialog. */
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      style={{ height: TARGET_ROW_HEIGHT }}
      className="flex w-full items-center gap-2 rounded-[10px] pr-3 pl-2 text-left text-[12px] hover:bg-[rgba(15,44,43,0.04)]"
    >
      {/* Fades out where it was and in where it now belongs. */}
      <span
        className="grid w-4 shrink-0 place-items-center"
        style={{
          opacity: props.active || props.icon ? 1 : 0,
          transition: "opacity 160ms var(--ease-enter)",
        }}
      >
        {props.icon ?? <CheckIcon size={12} strokeWidth={2} className="text-[var(--color-accent)]" />}
      </span>
      <span
        className={`min-w-0 flex-1 truncate ${props.active ? "font-semibold" : ""}`}
      >
        {props.label}
      </span>
      {props.hint && <span className="text-[10px] text-[var(--color-ink-3)]">{props.hint}</span>}
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
      <div className="flex items-baseline justify-between pb-1">
        <span className="text-[12px] text-[var(--color-ink-2)]">{props.label}</span>
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
  // Files that stayed over the limit even after quality and size gave way.
  // Silence would be the wrong answer here: the whole promise of the preset
  // is the number, so when it is missed the panel says so instead of the
  // usual "% der Obergrenze".
  const missed = files.filter((f) => f.limitMissed);
  // Smaller than the preset's own rules would give — the size limit had to
  // take pixels away. Worth saying even when the limit was then met: the
  // picture is quietly below what the preset promises. A source that was
  // small to begin with does not count; that one is never scaled.
  const shrunk = files.filter((f) => f.emergencyScaled);
  const shrunkTo = shrunk.length
    ? Math.min(...shrunk.map((f) => Math.max(f.width, f.height)))
    : null;
  const worst = missed.reduce(
    (max, f) => (max && max.bytes >= f.bytes ? max : f),
    undefined as (typeof files)[number] | undefined,
  );
  const overColor = "var(--color-over)";
  // The bar starts first, the number follows it in; the percentage belongs to
  // the number, not the bar.
  const barRamp = useRamp(1500, 340);
  const numberRamp = useRamp(1500, 440);
  const quality = useMemo(() => {
    const qualities = [...new Set(files.map((f) => f.quality))];
    return qualities.length === 1
      ? `Qualität ${qualities[0]}`
      : `Qualität ${Math.min(...qualities)} bis ${Math.max(...qualities)}`;
  }, [files]);

  return (
    <>
      {/* Drei Zeilen passen neben das 60 px hohe Vorschaubild, ohne dass der
          Block wächst — deshalb steht der Teilerfolg hier und nicht unter
          der Karte, wo er die feste Panelhöhe sprengen würde. */}
      <div className="flex items-center gap-3">
        <Thumb src={props.preview} badge over={!!worst || failed.length > 0} />
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <p className="truncate text-[13px] font-semibold">
            {failed.length > 0
              ? `${files.length} von ${result.images.length} fertig`
              : many
                ? `${files.length} Dateien`
                : first?.fileName}
          </p>
          <p className="truncate text-[11px] text-[var(--color-ink-2)] tabular-nums">
            {first && `${first.width} × ${first.height} px · ${quality}`}
          </p>
          {failureLines(failed).map((line) => (
            <p
              key={line}
              className="truncate text-[11px] text-[var(--color-over)]"
              title={failed.map((f) => `${sourceName(f.source)} — ${f.error}`).join("\n")}
            >
              {line}
            </p>
          ))}
        </div>
      </div>

      <div
        className="flex flex-col gap-[9px] rounded-[20px] bg-white/[0.62] px-3.5 py-[13px]"
        style={{ boxShadow: "inset 0 0 0 1px rgba(15,44,43,0.1)" }}
      >
        <div className="flex items-baseline gap-2">
          <span
            className="text-[27px] leading-none font-semibold tracking-[-0.02em] tabular-nums"
            style={worst ? { color: overColor } : undefined}
          >
            <Counting value={(bytes / 1000) * numberRamp} digits={bytes < 10000 ? 1 : 0} /> KB
          </span>
          <span className="text-[12px] text-[var(--color-ink-2)]">
            aus {kb(props.sourceBytes)}
          </span>
        </div>
        <div
          className="h-[7px] overflow-hidden rounded-full"
          style={{ background: "var(--color-divider)" }}
        >
          <div
            className="h-full rounded-full bg-[var(--color-accent)]"
            style={{
              width: `${used * barRamp}%`,
              ...(worst ? { background: overColor } : null),
            }}
          />
        </div>
        {/* One line, always: over the limit it carries the name, the size it
            really is and the quality it got to — same height, no scrolling. */}
        {worst ? (
          <div
            className="flex items-baseline justify-between gap-2 text-[10px] font-semibold tracking-[0.02em]"
            style={{ color: overColor }}
            title={`${worst.fileName} · ${kb(worst.bytes)} · Qualität ${worst.quality}${
              worst.emergencyScaled
                ? ` · auf ${worst.width} × ${worst.height} px verkleinert, um unter ${maxKb} KB zu kommen`
                : ""
            }`}
          >
            <span className="truncate">
              {missed.length > 1
                ? `${missed.length} von ${files.length} über ${maxKb} KB`
                : `Über ${maxKb} KB`}
              {worst.emergencyScaled &&
                ` · verkleinert auf ${Math.max(worst.width, worst.height)} px`}
            </span>
            <span className="shrink-0 tabular-nums">
              {kb(worst.bytes)} · Q{worst.quality}
            </span>
          </div>
        ) : (
          <div
            className="flex justify-between gap-2 text-[10px] font-medium tracking-[0.02em] text-[var(--color-ink-2)]"
            title={
              shrunkTo
                ? `Auf ${shrunkTo} px lange Kante verkleinert, um unter ${maxKb} KB zu bleiben`
                : undefined
            }
          >
            <span className="shrink-0 tabular-nums">
              <Counting value={used * numberRamp} digits={0} /> % der Obergrenze
            </span>
            {/* Normally the limit; when pixels had to give way, that instead —
                same line, same height, no warning colour, because nothing
                went wrong. */}
            <span className="truncate tabular-nums">
              {shrunkTo
                ? `verkleinert auf ${shrunkTo} px`
                : maxKb
                  ? `Grenze ${maxKb} KB`
                  : "ohne Grenze"}
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => first && revealItemInDir(many ? result.outputDir : first.path)}
          className="pressable h-11 flex-1 rounded-[15px] bg-white/80 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--color-divider)]"
        >
          Im Finder zeigen
        </button>
        <button
          onClick={props.onStartOver}
          className="pressable h-11 flex-1 rounded-[15px] bg-[var(--color-accent)] text-[13px] font-semibold text-white shadow-[0_4px_12px_rgba(6,22,26,0.22)]"
        >
          Noch eins
        </button>
      </div>
    </>
  );
}
