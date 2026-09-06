type SuggestOption = {
  label: string;
  value: string;
};

type SuggestMenuProps = {
  onSelect: (value: string) => void;
  options: SuggestOption[];
};

export default function SuggestMenu({ onSelect, options }: SuggestMenuProps) {
  if (options.length === 0) {
    return null;
  }

  return (
    <div className="suggest-menu">
      {options.map((option) => (
        <button
          className="suggest-option"
          key={option.value}
          onClick={() => onSelect(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
