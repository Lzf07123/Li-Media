import type { ButtonHTMLAttributes, PointerEvent as ReactPointerEvent } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const variantClass: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  danger: "btn-danger",
  ghost: "btn-ghost",
};

export default function Button({
  className = "",
  onPointerDown,
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
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
      className={`btn ${variantClass[variant]} ${className}`}
      onPointerDown={createRipple}
      type={type}
      {...props}
    />
  );
}
