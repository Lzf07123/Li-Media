import type { InputHTMLAttributes, ReactNode } from "react";

type FieldCheckProps = InputHTMLAttributes<HTMLInputElement> & {
  children: ReactNode;
  type?: "checkbox" | "radio";
};

export default function FieldCheck({ children, className = "", ...props }: FieldCheckProps) {
  return (
    <label className={`field-check ${className}`}>
      <input {...props} type={props.type ?? "checkbox"} />
      <span>{children}</span>
    </label>
  );
}
