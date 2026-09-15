import React from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  description?: React.ReactNode;
  id?: string;
  danger?: boolean;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  description,
  id,
  danger = false,
}: SwitchProps) {
  return (
    <label
      htmlFor={id}
      className={`modern-switch-container ${disabled ? "disabled" : ""} ${danger ? "danger" : ""}`}
    >
      <div className="modern-switch-text">
        {label && <span className="modern-switch-label">{label}</span>}
        {description && <span className="modern-switch-desc">{description}</span>}
      </div>
      <div
        className={`modern-switch-track ${checked ? "checked" : ""} ${danger ? "danger" : ""}`}
        onClick={(e) => {
          if (!disabled) {
            e.preventDefault();
            onChange(!checked);
          }
        }}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="modern-switch-input"
          aria-checked={checked}
        />
        <span className="modern-switch-thumb" />
      </div>
    </label>
  );
}
