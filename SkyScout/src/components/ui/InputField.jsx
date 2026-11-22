import { useId } from 'react';

function InputField({
  label,
  icon: Icon,
  type = "text",
  placeholder,
  value,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  autoComplete,
  disabled = false,
  name,
  id,
  role,
  ariaAutocomplete,
  ariaExpanded,
  ariaControls,
  ariaActiveDescendant,
}) {
  const generatedId = useId();
  const fieldId = id || generatedId;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={fieldId} className="mb-2 block text-sm font-semibold text-gray-700">
          {label}
        </label>
      )}

      <div className="relative">
        {Icon && (
          <Icon
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"
          />
        )}

        <input
          type={type}
          id={fieldId}
          name={name}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onFocus={onFocus}
          onBlur={onBlur}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          role={role}
          aria-autocomplete={ariaAutocomplete}
          aria-expanded={ariaExpanded}
          aria-controls={ariaControls}
          aria-activedescendant={ariaActiveDescendant}
          className={`
            w-full
            rounded-2xl
            border
            border-gray-300
            bg-white
            py-3
            ${Icon ? "pl-11" : "pl-4"}
            pr-4
            text-gray-800
            outline-none
            transition-all
            duration-300
            focus:border-violet-600
            focus:ring-4
            focus:ring-violet-100
            disabled:cursor-not-allowed
            disabled:bg-gray-100
          `}
        />
      </div>
    </div>
  );
}

export default InputField;
