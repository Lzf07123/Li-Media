type AvatarSize = "sm" | "md" | "lg";

type AvatarProps = {
  alt?: string;
  name: string;
  size?: AvatarSize;
  src?: string;
};

const sizeClass = {
  sm: "avatar-sm",
  md: "avatar-md",
  lg: "avatar-lg",
} as const;

export default function Avatar({ alt = "", name, size = "md", src }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");

  if (src) {
    return <img alt={alt || name} className={`avatar ${sizeClass[size]}`} src={src} />;
  }

  return (
    <span aria-hidden="true" className={`avatar avatar-placeholder ${sizeClass[size]}`}>
      {initials}
    </span>
  );
}
