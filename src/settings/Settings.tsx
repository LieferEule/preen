import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Switch } from "../components/Switch";
import { getVersion } from "@tauri-apps/api/app";
import { desktopDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { Popover } from "../components/Popover";
import PreenMark from "../components/icons/PreenMark";
import { CheckIcon, ChevronIcon, FolderIcon } from "../components/icons/Glyphs";
import {
  TARGET_DESKTOP,
  TARGET_SOURCE,
  appSettings,
  hideSettings,
  quitApp,
  setAutoHideSeconds,
  rememberTarget,
  resizeSettingsWindow,
  setDefaultTarget,
  setShortcut,
  setShowInDock,
  shortcutLabel,
  type Target,
} from "../lib/api";

export default function Settings() {
  const [shortcut, setShortcutValue] = useState("Alt+Cmd+P");
  const [label, setLabel] = useState("⌥⌘P");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>(TARGET_SOURCE);
  const [dock, setDock] = useState(false);
  const [autostart, setAutostart] = useState(true);
  const [autoHide, setAutoHide] = useState(20);
  const [targetMenu, setTargetMenu] = useState(false);
  const [version, setVersion] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    appSettings().then((s) => {
      setShortcutValue(s.shortcut);
      setTarget(s.defaultTarget);
      setDock(s.showInDock);
      setAutoHide(s.autoHideSeconds);
      shortcutLabel(s.shortcut).then(setLabel);
    });
    autostartEnabled().then(setAutostart);
    getVersion().then(setVersion);
  }, []);

  // The window is as tall as its content.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const report = () => resizeSettingsWindow(Math.ceil(element.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Cmd+W and Esc close the window — hide, never close, or the app is gone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const close = e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "w");
      if (!close || recording) return;
      e.preventDefault();
      hideSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  // Recording: the next combination with a real modifier wins.
  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const accelerator = toAccelerator(e);
      if (!accelerator) return; // keep waiting for a usable combination
      setRecording(false);
      try {
        await setShortcut(accelerator);
        setShortcutValue(accelerator);
        setLabel(await shortcutLabel(accelerator));
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  const pickTarget = (value: Target) => {
    setTarget(value);
    setDefaultTarget(value);
    setTargetMenu(false);
  };

  const chooseFolder = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") {
      setTarget(dir);
      setDefaultTarget(dir);
      rememberTarget(dir);
    }
    setTargetMenu(false);
  };

  const toggleDock = (value: boolean) => {
    setDock(value);
    setShowInDock(value);
  };

  const toggleAutostart = async (value: boolean) => {
    setAutostart(value);
    try {
      await (value ? enableAutostart() : disableAutostart());
    } catch {
      setAutostart(!value);
    }
  };

  return (
    <div
      ref={root}
      className="overflow-hidden rounded-[26px]"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.86) 0%, rgba(232,241,239,0.66) 100%)",
        boxShadow:
          "0 30px 70px rgba(6,22,26,0.46), 0 4px 12px rgba(6,22,26,0.22), inset 0 1px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.4)",
      }}
    >
      {/* "deep": a press anywhere in the bar drags the window; Tauri keeps
          buttons out of it by itself. */}
      <div
        className="relative h-[46px]"
        style={{ boxShadow: "inset 0 -1px 0 rgba(15,44,43,0.1)" }}
      >
        {/* The drag surface is its own layer across the whole bar. The buttons
            sit above it as siblings, so neither can swallow the other. */}
        <div data-tauri-drag-region className="absolute inset-0" />
        <h1 className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] font-semibold">
          Einstellungen
        </h1>
        <div className="absolute top-1/2 left-4 z-10 flex -translate-y-1/2 items-center gap-2">
          <button
            type="button"
            onClick={() => hideSettings()}
            aria-label="Schließen"
            className="size-3 rounded-full bg-[#ec6a5e]"
          />
          {/* Resizing and full screen make no sense for this window. */}
          <button
            type="button"
            disabled
            aria-label="Minimieren"
            className="size-3 rounded-full bg-[rgba(15,44,43,0.16)]"
          />
          <button
            type="button"
            disabled
            aria-label="Vollbild"
            className="size-3 rounded-full bg-[rgba(15,44,43,0.16)]"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1 px-[22px] pt-5 pb-[18px]">
        <Row label="Tastenkürzel" hint="Holt das Panel nach vorn">
          <div className="flex items-center gap-2">
            <kbd
              className={`grid h-8 min-w-[70px] place-items-center rounded-[10px] px-3 text-[14px] font-semibold tracking-[0.06em] ${
                recording ? "bg-[var(--color-accent)] text-white" : "bg-white/90 text-[var(--color-ink)]"
              }`}
              style={
                recording
                  ? undefined
                  : {
                      boxShadow:
                        "inset 0 0 0 1px rgba(15,44,43,0.14), 0 1px 2px rgba(6,22,26,0.1)",
                    }
              }
            >
              {recording ? "Tasten drücken…" : label}
            </kbd>
            <button
              onClick={() => {
                setError(null);
                setRecording((r) => !r);
              }}
              className="pressable h-8 rounded-[10px] px-[13px] text-[12.5px] font-semibold text-[#234744]"
              style={{ background: "rgba(15,44,43,0.07)" }}
            >
              {recording ? "Abbrechen" : "Ändern"}
            </button>
          </div>
        </Row>
        {error && (
          <p className="-mt-1 pb-2 text-right text-[11px] text-[var(--color-over)]">
            {error} Die bisherige Kombination bleibt aktiv.
          </p>
        )}

        <Row label="Standard-Zielort" hint="Lässt sich im Panel pro Bild überschreiben">
          <div className="relative">
            <button
              onClick={() => setTargetMenu((open) => !open)}
              aria-expanded={targetMenu}
              title={targetTitle(target)}
              className="pressable flex h-8 shrink-0 items-center gap-2 rounded-[10px] bg-white/90 pr-2.5 pl-3"
              style={{ boxShadow: "inset 0 0 0 1px rgba(15,44,43,0.14)" }}
            >
              <FolderIcon size={14} className="text-[var(--color-accent)]" />
              <span className="max-w-52 truncate text-[12.5px] font-semibold">
                {targetLabel(target)}
              </span>
              <ChevronIcon className="text-[var(--color-ink-3)]" />
            </button>
            <Popover open={targetMenu} width={224} align="right" label="Standard-Zielort">
              <MenuItem
                label="Neben dem Original"
                active={target === TARGET_SOURCE}
                onClick={() => pickTarget(TARGET_SOURCE)}
              />
              <MenuItem
                label="Schreibtisch"
                active={target === TARGET_DESKTOP}
                onClick={() => pickTarget(TARGET_DESKTOP)}
              />
              <div className="my-1" style={{ height: 1, background: "var(--color-hair-soft)" }} />
              <MenuItem
                label="Anderen Ordner wählen …"
                icon={<FolderIcon size={13} className="text-[var(--color-ink-3)]" />}
                onClick={chooseFolder}
              />
            </Popover>
          </div>
        </Row>

        <Row label="Im Dock anzeigen" hint="Aus heißt: Preen lebt nur in der Menüleiste">
          <Switch checked={dock} onChange={toggleDock} label="Im Dock anzeigen" />
        </Row>

        <Row label="Bei Anmeldung starten" hint="Damit das Kürzel immer sitzt">
          <Switch checked={autostart} onChange={toggleAutostart} label="Bei Anmeldung starten" />
        </Row>

        <Row label="Automatisch ausblenden" hint="Nur solange kein Bild geladen ist" htmlFor="auto-hide" last>
          <AutoHideSlider
            value={autoHide}
            onChange={(seconds) => {
              setAutoHide(seconds);
              setAutoHideSeconds(seconds);
            }}
          />
        </Row>
      </div>

      <div
        className="flex items-center gap-3 px-[22px] py-[13px]"
        style={{
          background: "rgba(15,44,43,0.05)",
          boxShadow: "inset 0 1px 0 rgba(15,44,43,0.09)",
        }}
      >
        <PreenMark size={15} height={17.5} className="shrink-0 text-[var(--color-feather)]" />
        <span className="flex-1 text-[11.5px] text-[var(--color-ink-2)]">Preen {version}</span>
        <button
          onClick={quitApp}
          className="pressable h-[30px] rounded-[10px] px-[13px] text-[12.5px] font-semibold text-[#3e5c59]"
        >
          Preen beenden
        </button>
      </div>
    </div>
  );
}

/** Aus · 10 s · 20 s · 30 s · 1 min — the slider's five notches. */
const AUTO_HIDE_STEPS = [0, 10, 20, 30, 60];

function autoHideLabel(seconds: number) {
  if (seconds <= 0) return "Aus";
  return seconds >= 60 ? "1 min" : `${seconds} s`;
}

/** What a screen reader should say instead of the bare notch number. */
function autoHideSpeech(seconds: number) {
  if (seconds <= 0) return "Aus";
  return seconds >= 60 ? "1 Minute" : `${seconds} Sekunden`;
}

/**
 * Five notches, not a free-running value: `step` does the snapping, the ticks
 * underneath show that it snaps. The value sits in a column of its own width,
 * so the row doesn't jump between "Aus" and "1 min".
 */
function AutoHideSlider(props: { value: number; onChange: (seconds: number) => void }) {
  const notch = Math.max(
    0,
    AUTO_HIDE_STEPS.findIndex((step) => step === props.value),
  );
  const filled = (notch / (AUTO_HIDE_STEPS.length - 1)) * 100;
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <div className="relative" style={{ width: 140 }}>
        <input
          id="auto-hide"
          type="range"
          min={0}
          max={AUTO_HIDE_STEPS.length - 1}
          step={1}
          value={notch}
          aria-valuetext={autoHideSpeech(props.value)}
          onChange={(e) => props.onChange(AUTO_HIDE_STEPS[Number(e.target.value)])}
          className="w-full"
          style={{
            ["--range-track" as string]: `linear-gradient(90deg, var(--color-accent) ${filled}%, rgba(15,44,43,0.16) ${filled}%)`,
          }}
        />
        {/* One mark per notch, lined up with where the knob comes to rest. */}
        <div className="pointer-events-none absolute inset-x-0 top-[18px]">
          {AUTO_HIDE_STEPS.map((step, i) => (
            <span
              key={step}
              className="absolute block h-1 w-px"
              style={{
                left: `calc(7.5px + ${i} * ((100% - 15px) / ${AUTO_HIDE_STEPS.length - 1}))`,
                background: "rgba(15,44,43,0.2)",
              }}
            />
          ))}
        </div>
      </div>
      <span
        className="shrink-0 text-right tabular-nums"
        style={{ width: 46, fontSize: "12.5px", fontWeight: 600 }}
      >
        {autoHideLabel(props.value)}
      </span>
    </div>
  );
}

function MenuItem(props: {
  label: string;
  active?: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={props.onClick}
      className="flex h-7 w-full items-center gap-2 rounded-[10px] pr-3 pl-2 text-left text-[12px] hover:bg-[rgba(15,44,43,0.04)]"
    >
      <span
        className="grid w-4 shrink-0 place-items-center"
        style={{
          opacity: props.active || props.icon ? 1 : 0,
          transition: "opacity 160ms var(--ease-enter)",
        }}
      >
        {props.icon ?? <CheckIcon size={12} strokeWidth={2} className="text-[var(--color-accent)]" />}
      </span>
      <span className={`min-w-0 flex-1 truncate ${props.active ? "font-semibold" : ""}`}>
        {props.label}
      </span>
    </button>
  );
}

/** The full path behind an abbreviated folder name. */
function targetTitle(target: Target) {
  if (target === TARGET_SOURCE) return "Neben dem Original";
  if (target === TARGET_DESKTOP) return "Schreibtisch";
  return target;
}

function targetLabel(target: Target) {
  if (target === TARGET_SOURCE) return "Neben dem Original";
  if (target === TARGET_DESKTOP) return "Schreibtisch";
  return target.split("/").pop() ?? target;
}

function Row(props: {
  label: string;
  /** One line saying what the setting is for. */
  hint: string;
  /** Ties the label to the control, for screen readers and click-to-focus. */
  htmlFor?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  const label = props.htmlFor ? (
    <label htmlFor={props.htmlFor} className="text-[13.5px] font-semibold">
      {props.label}
    </label>
  ) : (
    <span className="text-[13.5px] font-semibold">{props.label}</span>
  );
  return (
    <>
      <div className="flex items-center gap-4 py-[11px]">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {label}
          <p className="text-[11.5px] text-[var(--color-ink-2)]">{props.hint}</p>
        </div>
        {props.children}
      </div>
      {!props.last && <div style={{ height: 1, background: "var(--color-hair-soft)" }} />}
    </>
  );
}


/**
 * Tauri accelerator for a key event, or null when the combination is not
 * allowed: a bare key, or Cmd / Shift as the only modifier.
 */
function toAccelerator(e: KeyboardEvent): string | null {
  const modifiers: string[] = [];
  if (e.ctrlKey) modifiers.push("Ctrl");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");
  if (e.metaKey) modifiers.push("Cmd");
  if (modifiers.length === 0) return null;
  if (modifiers.length === 1 && (modifiers[0] === "Cmd" || modifiers[0] === "Shift")) return null;

  const code = e.code;
  const isKey =
    /^(Key[A-Z]|Digit[0-9]|F[0-9]{1,2}|Space|Enter|Tab|Backspace|Escape|Arrow(Up|Down|Left|Right)|Comma|Period|Slash|Minus|Equal|Backquote|Bracket(Left|Right)|Semicolon|Quote|Backslash)$/.test(
      code,
    );
  if (!isKey) return null; // a modifier alone is not a shortcut
  return [...modifiers, code].join("+");
}
