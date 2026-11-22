function SectionTitle({
  title,
  subtitle,
  align = "center",
}) {
  const alignment = {
    left: "text-left",
    center: "text-center",
    right: "text-right",
  };

  return (
    <div className={alignment[align]}>
      <h2 className="text-4xl font-bold text-gray-900">
        {title}
      </h2>

      {subtitle && (
        <p className="mt-4 text-lg text-gray-600">
          {subtitle}
        </p>
      )}
    </div>
  );
}

export default SectionTitle;