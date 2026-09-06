type StatusDotProps = {
  label?: string;
  tone: "connected" | "connecting" | "disconnected" | "invalid";
};

const toneClass = {
  connected: "status-connected",
  connecting: "status-connecting",
  disconnected: "status-disconnected",
  invalid: "status-invalid",
} as const;

export default function StatusDot({ label, tone }: StatusDotProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className={`status-dot ${toneClass[tone]}`} />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
