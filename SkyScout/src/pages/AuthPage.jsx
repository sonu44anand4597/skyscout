import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Plane } from "lucide-react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext.jsx";
import { apiRequest, getServiceHealth } from "../api/client.js";
import ThemeToggle from "../components/layout/ThemeToggle.jsx";
import { dashboardPath, internalReturnPath } from '../utils/navigation.js';

export default function AuthPage({ mode }) {
  const registering = mode === "register";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [serviceHealth, setServiceHealth] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { signIn } = useAuth();

  useEffect(() => {
    let mounted = true;
    getServiceHealth().then((health) => { if (mounted) setServiceHealth(health); }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await signIn(registering ? { name, email, password } : { email, password }, registering);
      const pending = location.state?.pendingTrack;
      if (pending) {
        const saved = await apiRequest("/tracked-flights", { method: "POST", body: pending });
        toast.success("Flight added to your watchlist.");
        navigate(dashboardPath(saved.data?._id), { replace: true });
      } else navigate(internalReturnPath(location.state?.from), { replace: true });
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="absolute right-5 top-5"><ThemeToggle /></div>
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-xl sm:p-10">
        <Link to="/" className="inline-flex items-center gap-2 font-extrabold text-violet-700"><Plane size={21} /> SkyScout</Link>
        <h1 className="mt-8 text-3xl font-bold text-slate-900">{registering ? "Create your account" : "Welcome back"}</h1>
        <p className="mt-2 text-sm text-slate-600">{registering ? "Save and monitor the flights you care about." : "Sign in to see your tracked flights and alerts."}</p>
        {serviceHealth && serviceHealth.services?.database !== "connected" && <p role="status" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900">Accounts, tracking, and saved alerts are temporarily unavailable while the database reconnects. Flight search remains available.</p>}
        {serviceHealth?.services?.flightSearch === "unconfigured" && <p role="status" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900">Flight search is not configured on this server.</p>}
        <form onSubmit={submit} className="mt-7 space-y-5">
          {registering && <label className="block text-sm font-semibold text-slate-700">Name<input required minLength={2} maxLength={80} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100" /></label>}
          <label className="block text-sm font-semibold text-slate-700">Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100" /></label>
          <label className="block text-sm font-semibold text-slate-700">Password<input required type="password" minLength={registering ? 10 : 1} maxLength={128} autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100" />{registering && <span className="mt-1 block text-xs font-normal text-slate-500">Use at least 10 characters.</span>}</label>
          {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <button disabled={busy} className="w-full rounded-xl bg-violet-700 px-5 py-3.5 font-semibold text-white transition hover:bg-violet-800 disabled:opacity-60">{busy ? "Please wait…" : registering ? "Create account" : "Sign in"}</button>
        </form>
        <p className="mt-6 text-center text-sm text-slate-600">{registering ? "Already have an account?" : "New to SkyScout?"} <Link to={registering ? "/login" : "/register"} state={location.state} className="font-semibold text-violet-700 hover:underline">{registering ? "Sign in" : "Create an account"}</Link></p>
      </section>
    </main>
  );
}
