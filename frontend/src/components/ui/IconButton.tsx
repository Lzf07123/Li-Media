import type { ButtonHTMLAttributes } from "react";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export default function IconButton({ className = "", type = "button", ...props }: IconButtonProps) {
  return <button className={`icon-btn ${className}`} type={type} {...props} />;
}
