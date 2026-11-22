function Card({ children, className = "" }) {
  return (
    <div className={`rounded-3xl border border-gray-200 bg-white p-8 shadow-lg ${className}`}>
      {children}
    </div>
  );
}

export default Card;
