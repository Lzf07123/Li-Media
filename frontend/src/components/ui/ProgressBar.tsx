type ProgressBarProps = {
  label: string;
  tone?: "primary" | "success" | "danger";
  value: number;
};

const toneClass = {
  primary: "",
  success: "is-success",
  danger: "is-danger",
};

export default function ProgressBar({ label, tone = "primary", value }: ProgressBarProps) {
  const boundedValue = Math.min(100, Math.max(0, value));

  return (
    <div aria-valuemax={100} aria-valuemin={0} aria-valuenow={boundedValue} aria-label={label} role="progressbar">
      <span className={`progress ${toneClass[tone]}`}>
        <span className="progress-bar" style={{ width: `${boundedValue}%` }} />
      </span>
    </div>
  );
}
