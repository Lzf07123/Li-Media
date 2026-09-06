import type { CSSProperties } from "react";

const dotColors = [
  "var(--color-accent-ice)",
  "var(--color-accent-aqua)",
  "var(--color-accent-lilac)",
  "var(--color-accent-sage)",
] as const;

const dotPositions = [
  { top: "18%", left: "12%" },
  { top: "32%", right: "18%" },
  { bottom: "28%", left: "22%" },
  { bottom: "18%", right: "12%" },
] as const;

export default function AmbientBackground() {
  return (
    <div aria-hidden="true" className="ambient-layer">
      <div className="aurora aurora-soft">
        <span className="aurora-blob" />
        <span className="aurora-blob" />
      </div>
      <div className="tech-ambience tech-ambience--soft">
        <span className="tech-grid" />
        <span className="tech-beam" />
        <span className="tech-beam tech-beam--violet" />
        <span className="tech-beam tech-beam--sage" />
        {dotPositions.map((position, index) => (
          <span
            className="tech-dot"
            key={dotColors[index]}
            style={
              {
                ...position,
                "--tech-dot-color": dotColors[index],
              } as unknown as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
