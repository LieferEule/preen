/** The one switch both windows use. `compact` is the panel's size — the
 *  settings window has more room. */
export function Switch(props: {
  checked: boolean;
  label: string;
  compact?: boolean;
  onChange: (value: boolean) => void;
}) {
  const track = props.compact ? "h-[22px] w-[38px]" : "h-[26px] w-[44px]";
  const knob = props.compact ? "size-4 top-[3px]" : "size-5 top-[3px]";
  const left = props.compact
    ? props.checked
      ? "left-[19px]"
      : "left-[3px]"
    : props.checked
      ? "left-[21px]"
      : "left-[3px]";
  return (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      className={`relative shrink-0 rounded-full transition-colors duration-[240ms] ${track} ${
        props.checked ? "bg-[var(--color-accent)]" : "bg-[rgba(15,44,43,0.18)]"
      }`}
    >
      <span
        className={`absolute rounded-full bg-white shadow-[0_1px_3px_rgba(6,22,26,0.3)] transition-[left] duration-[240ms] ${knob} ${left}`}
        style={{ transitionTimingFunction: "var(--ease-ui)" }}
      />
    </button>
  );
}
