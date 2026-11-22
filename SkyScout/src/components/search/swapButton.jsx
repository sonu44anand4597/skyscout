

import {ArrowLeftRight} from "lucide-react";

function SwapButton({onSwap}) {
    return (    
        <button
        type="button"
        aria-label="Swap origin and destination"
        onClick={onSwap}
        className="mb-1 flex h-12 w-12 items-center justify-center rounded-full border border-gray-300 bg-white text-xl shadow-sm transition hover:bg-violet-50"    
         >
            <ArrowLeftRight size={20} />
        </button>
    )
}

export default SwapButton;
