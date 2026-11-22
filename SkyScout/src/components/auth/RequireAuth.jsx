import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";

export default function RequireAuth({ children }) {
  const { user, loading, sessionError, refreshUser } = useAuth();
  const location = useLocation();
  if (loading) return <div className="flex min-h-screen items-center justify-center text-slate-600">Checking your session…</div>;
  if (sessionError && !user) return <main className="flex min-h-screen items-center justify-center px-6"><section role="alert" className="max-w-md rounded-2xl border border-amber-200 bg-white p-6 text-slate-800"><h1 className="text-xl font-bold">Your session could not be checked</h1><p className="mt-3 text-sm text-slate-600">{sessionError}</p><button type="button" onClick={refreshUser} className="mt-5 rounded-xl bg-violet-700 px-4 py-3 font-semibold text-white">Try again</button></section></main>;
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  return children;
}
