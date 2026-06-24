import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUp } from "lucide-react";

export function AssistantComposer({
  suggestions,
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: {
  suggestions?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const [showEmptyError, setShowEmptyError] = useState(false);
  const trimmedValue = value.trim();
  const isEmpty = trimmedValue.length === 0;
  const isInvalid = showEmptyError && isEmpty;
  const canSubmit = !isEmpty && !disabled;

  function handleSubmit() {
    if (disabled) return;
    if (isEmpty) {
      setShowEmptyError(true);
      inputRef.current?.focus();
      return;
    }
    setShowEmptyError(false);
    onSubmit();
  }

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="assistant-drawer-composer"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      {suggestions}
      <textarea
        ref={inputRef}
        value={value}
        disabled={disabled}
        aria-invalid={isInvalid ? "true" : undefined}
        aria-describedby={isInvalid ? errorId : undefined}
        onChange={(e) => {
          if (showEmptyError) setShowEmptyError(false);
          onChange(e.currentTarget.value);
        }}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      />
      {isInvalid && (
        <p className="assistant-composer-error" id={errorId} role="alert">
          Enter a message before sending.
        </p>
      )}
      <button
        className="primary-action"
        type="submit"
        disabled={!canSubmit}
      >
        <ArrowUp size={16} />
        {disabled ? "Thinking..." : "Send"}
      </button>
    </form>
  );
}
