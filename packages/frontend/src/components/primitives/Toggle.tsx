interface ToggleProps {
  on: boolean;
  title: string;
  desc?: string;
  onChange: (next: boolean) => void;
}

export function Toggle({ on, title, desc, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <div className="toggle-label">
        <div className="t">{title}</div>
        {desc && <div className="d">{desc}</div>}
      </div>
      <div className={`sw ${on ? 'is-on' : ''}`} />
    </button>
  );
}
