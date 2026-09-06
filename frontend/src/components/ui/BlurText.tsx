import type { CSSProperties, ElementType } from "react";

type BlurTextProps = {
  as?: ElementType;
  className?: string;
  id?: string;
  text: string;
};

export default function BlurText({
  as: Tag = "span",
  className = "",
  id,
  text,
}: BlurTextProps) {
  const words = text.split(/\s+/).filter(Boolean);

  return (
    <Tag className={className} id={id}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, index) => (
          <span
            className="blur-unit"
            key={`${word}-${index}`}
            style={{ "--blur-index": index } as unknown as CSSProperties}
          >
            {word}
            {index < words.length - 1 ? " " : ""}
          </span>
        ))}
      </span>
    </Tag>
  );
}
