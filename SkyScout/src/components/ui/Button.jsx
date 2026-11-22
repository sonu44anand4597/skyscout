function Button({
  as: Component = 'button',
  children,
  variant = "primary",
  className = "",
  ...props
}) {
  const baseStyle =
    "rounded-2xl px-6 py-3 font-semibold transition-all duration-300";

  const variants = {
    primary:
      "bg-violet-600 text-white hover:bg-violet-700",

    outline:
      "border border-violet-600 text-violet-600 hover:bg-violet-50",

    secondary:
      "bg-gray-100 text-gray-900 hover:bg-gray-200",

    danger:
      "bg-red-600 text-white hover:bg-red-700",
  };

  return (
    <Component
      className={`${baseStyle} ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </Component>
  );
}

export default Button;
