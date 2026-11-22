import { Link } from "react-router-dom";
import { Plane } from "lucide-react";
import { useAuth } from "../../context/AuthContext.jsx";
import ThemeToggle from "./ThemeToggle.jsx";

function Navbar() {
  const { user, loading } = useAuth();
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur-lg">
      <nav aria-label="Main navigation" className="mx-auto flex min-h-18 max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8">
        <Link to="/" className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white"><Plane size={21} /></span><span className="text-xl font-extrabold tracking-tight text-slate-900">SkyScout</span></Link>
        <div className="flex items-center gap-1 text-xs font-semibold sm:gap-3 sm:text-sm">
          <ThemeToggle />
          <Link to="/#flight-search" className="hidden text-slate-700 hover:text-violet-700 sm:block">Search flights</Link>
          {!loading && user && <Link to="/dashboard" className="rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-100">Dashboard</Link>}
          {!loading && !user && <Link to="/login" className="rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-100">Sign in</Link>}
          {!loading && !user && <Link to="/register" className="rounded-xl bg-violet-700 px-4 py-2.5 text-white hover:bg-violet-800">Create account</Link>}
        </div>
      </nav>
    </header>
  );
}

export default Navbar;
