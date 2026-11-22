function Badge({
  children,
  variant = "success",
  className = "",
}) {
  const baseStyle =
    "inline-flex items-center rounded-full px-3 py-1 text-sm font-medium";

  const variants = {
    success:
      "bg-green-100 text-green-700",

    warning:
      "bg-yellow-100 text-yellow-700",

    info:
      "bg-blue-100 text-blue-700",

    primary:
      "bg-violet-100 text-violet-700",
  };

  return (
    <span
      className={`${baseStyle} ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

export default Badge;