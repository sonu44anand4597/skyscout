
       
       
     import {
  Search,
  Plane,
  Users,
  Armchair,
} from "lucide-react";

const features = [
  {
    icon: Search,
    title: "Live fare search",
  },
  {
    icon: Plane,
    title: "Compare itineraries",
  },
  {
    icon: Users,
    title: "Passenger options",
  },
  {
    icon: Armchair,
    title: "Cabin selection",
  },
];

function HeroFeatures() {
  return (
    <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-slate-200 pt-6 sm:grid-cols-4">
      {features.map((feature) => {
        const Icon = feature.icon;

        return (
          <div
            key={feature.title}
            className="flex flex-col items-start gap-2"
          >
            <Icon size={21} aria-hidden="true" className="text-violet-600" />

            <p className="text-xs font-medium text-slate-600">
              {feature.title}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export default HeroFeatures;  
