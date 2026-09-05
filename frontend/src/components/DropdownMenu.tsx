import { useEffect, useRef, useState, type ReactNode } from "react";

type DropdownMenuProps = {
  buttonContent: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
};

export default function DropdownMenu({ buttonContent, children }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const close = () => setIsOpen(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className="icon-btn"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        {buttonContent}
      </button>
      {isOpen ? (
        <div className="dropdown-menu" role="menu">
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}
