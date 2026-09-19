import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { desktopDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import PreenMark from "../components/icons/PreenMark";
import { ChevronIcon, FolderIcon } from "../components/icons/Glyphs";
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

  const chooseTarget = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") {
      setTarget(dir);
      setDefaultTarget(dir);
      rememberTarget(dir);
    }
  };

  const cycleTarget = async () => {
    // Quellordner → Schreibtisch → eigener Ordner …
    if (target === TARGET_SOURCE) {
      setTarget(TARGET_DESKTOP);
      setDefaultTarget(TARGET_DESKTOP);
    } else if (target === TARGET_DESKTOP) {
      await chooseTarget();
    } else {
      setTarget(TARGET_SOURCE);
      setDefaultTarget(TARGET_SOURCE);
    }
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
    <div ref={root} className="glass-body overflow-hidden rounded-[26px]">
      {/* "deep": a press anywhere in the bar drags the window; Tauri keeps
          buttons out of it by itself. */}
      <div className="relative h-[46px]">
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
            className="size-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]"
          />
          {/* Resizing and full screen make no sense for this window. */}
          <button
            type="button"
            disabled
            aria-label="Minimieren"
            className="size-3 rounded-full bg-[rgba(15,44,43,0.14)]"
          />
          <button
            type="button"
            disabled
            aria-label="Vollbild"
            className="size-3 rounded-full bg-[rgba(15,44,43,0.14)]"
          />
        </div>
      </div>

      <div className="px-5">
        <Row label="Tastenkürzel">
          <div className="flex items-center gap-2">
            <kbd
              className={`min-w-14 rounded-lg px-2.5 py-1 text-center text-[13px] font-semibold ${
                recording ? "bg-[var(--color-accent)] text-white" : "bg-white/80 text-[var(--color-ink)]"
              } shadow-[inset_0_0_0_1px_var(--color-hairline)]`}
            >
              {recording ? "Tasten drücken…" : label}
            </kbd>
            <button
              onClick={() => {
                setError(null);
                setRecording((r) => !r);
              }}
              className="rounded-lg px-2.5 py-1 text-[12px] font-semibold text-[var(--color-accent)]"
              style={{ background: "var(--color-quiet)" }}
            >
              {recording ? "Abbrechen" : "Ändern"}
            </button>
          </div>
        </Row>
        {error && (
          <p className="-mt-1 pb-2 text-right text-[11px] text-[#8c2f26]">
            {error} Die bisherige Kombination bleibt aktiv.
          </p>
        )}

        <Row label="Standard-Zielort">
          <button onClick={cycleTarget} className="flex items-center gap-2 text-[13px] font-semibold">
            <FolderIcon className="text-[var(--color-ink-3)]" />
            <span className="max-w-52 truncate">{targetLabel(target)}</span>
            <ChevronIcon className="text-[var(--color-ink-3)]" />
          </button>
        </Row>

        <Row label="Im Dock anzeigen">
          <Switch checked={dock} onChange={toggleDock} label="Im Dock anzeigen" />
        </Row>

        <Row label="Bei Anmeldung starten">
          <Switch checked={autostart} onChange={toggleAutostart} label="Bei Anmeldung starten" />
        </Row>

        <Row label="Automatisch ausblenden" htmlFor="auto-hide" last>
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
        className="flex items-center gap-2 px-5 py-3"
        style={{ background: "rgba(15, 44, 43, 0.05)" }}
      >
        <PreenMark size={14} height={16} className="text-[var(--color-feather)]" />
        <span className="text-[11px] text-[var(--color-ink-3)]">Preen {version}</span>
        <button
          onClick={quitApp}
          className="ml-auto text-[12px] font-semibold text-[var(--color-ink-2)]"
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
    <div className="flex items-center gap-3" style={{ width: 200 }}>
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
        <div className="pointer-events-none absolute inset-x-0 top-[17px]">
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
        className="text-right tabular-nums"
        style={{ width: 46, fontSize: "12.5px", fontWeight: 600 }}
      >
        {autoHideLabel(props.value)}
      </span>
    </div>
  );
}

function targetLabel(target: Target) {
  if (target === TARGET_SOURCE) return "Quellordner";
  if (target === TARGET_DESKTOP) return "Schreibtisch";
  return target.split("/").pop() ?? target;
}

function Row(props: {
  label: string;
  /** Ties the label to the control, for screen readers and click-to-focus. */
  htmlFor?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 py-[11px]"
      style={props.last ? undefined : { boxShadow: "inset 0 -1px 0 rgba(15, 44, 43, 0.09)" }}
    >
      {props.htmlFor ? (
        <label htmlFor={props.htmlFor} className="text-[13px]">
          {props.label}
        </label>
      ) : (
        <span className="text-[13px]">{props.label}</span>
      )}
      {props.children}
    </div>
  );
}

function Switch(props: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      className={`relative h-[26px] w-[44px] rounded-full transition-colors ${
        props.checked ? "bg-[var(--color-accent)]" : "bg-[rgba(15,44,43,0.16)]"
      }`}
    >
      <span
        className={`absolute top-[3px] size-5 rounded-full bg-white shadow-[0_1px_3px_rgba(6,22,26,0.3)] transition-[left] ${
          props.checked ? "left-[21px]" : "left-[3px]"
        }`}
      />
    </button>
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
