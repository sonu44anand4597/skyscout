function TripTypeSelector(props) {
  return (
    <div className="flex flex-wrap justify-center gap-x-8 gap-y-3">
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="tripType"
          value="one-way"
          checked={props.tripType === "one-way"}
          onChange={() => props.setTripType("one-way")}
        />
        One-way
      </label>

      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="tripType"
          value="round-trip"
          checked={props.tripType === "round-trip"}
          onChange={() => props.setTripType("round-trip")}
        />
        Round-trip
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="tripType"
          value="multi-city"
          checked={props.tripType === "multi-city"}
          onChange={() => props.setTripType("multi-city")}
        />
        Multi-city
      </label>
    </div>
  );
}

export default TripTypeSelector;
