

function TravellerRow (props) {

    return (
        <div className="flex items-center justify-between">

            <div>
                <h3 className="font-semibold text-gray-900">
                    {props.title}
                </h3>
                <p className="text-sm text-gray-500">
                    {props.subtitle}
                    </p>
            </div>
                 
                 <div className="flex items-center gap-4">
                    <button type="button" aria-label={`Remove ${props.title.toLowerCase()}`} disabled={props.count <= props.min}
                    onClick={() => {
                        if (props.count > props.min) {
                            props.setCount(props.count - 1);
                        }
                    }}
                    className="h-8 w-8 rounded-full border border-gray-300" >
                        -
                    </button>
                    <span>{props.count}</span>

                    <button type="button" aria-label={`Add ${props.title.toLowerCase()}`} disabled={props.count >= props.max}
                    onClick={() => props.setCount(props.count + 1)}
                    className="h-8 w-8 rounded-full border border-gray-300">
                        +
                    </button>

                 </div>

        </div>
    )
}

export default TravellerRow
