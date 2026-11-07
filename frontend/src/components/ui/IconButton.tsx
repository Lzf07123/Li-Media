import type { ButtonHTMLAttributes, PointerEvent as ReactPointerEvent } from "react";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export default function IconButton({
  className = "",
  onPointerDown,
  type = "button",
  ...props
}: IconButtonProps) {
  // 与 Button 同一按压涟漪：图标按钮不再只有换色反馈
  const createRipple = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const ripple = document.createElement("span");
    ripple.className = "btn-ripple";
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
    ripple.addEventListener("animationend", () => ripple.remove());
    button.appendChild(ripple);
    onPointerDown?.(event);
  };

  return (
    <button
      className={`icon-btn ${className}`}
      onPointerDown={createRipple}
      type={type}
      {...props}
    />
  );
}
