function getAirlineLogo(name) {
  const logos = {
    "IndiGo": { initials: "6E", color: "bg-blue-500" },
    "Air India": { initials: "AI", color: "bg-orange-500" },
    "Akasa Air": { initials: "QP", color: "bg-purple-500" },
  };

  return logos[name] || { initials: name.substring(0, 2).toUpperCase(), color: "bg-gray-500" };
}

export default getAirlineLogo;