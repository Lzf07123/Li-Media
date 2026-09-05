import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  id: string;
};

export function Input({ className = "", label, id, ...props }: InputProps) {
  return (
    <label className="flex flex-col gap-2 text-sm" htmlFor={id}>
      {label}
      <input className={`input min-h-11 ${className}`} id={id} {...props} />
    </label>
  );
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: ReactNode;
  id: string;
};

export function TextArea({ className = "", label, id, ...props }: TextAreaProps) {
  return (
    <label className="flex flex-col gap-2 text-sm" htmlFor={id}>
      {label}
      <textarea className={`input min-h-28 ${className}`} id={id} {...props} />
    </label>
  );
}
