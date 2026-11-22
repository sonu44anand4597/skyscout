import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";

import RequireAuth from "./components/auth/RequireAuth.jsx";
import { useTheme } from "./context/theme.js";

const Home = lazy(() => import("./pages/Home.jsx"));
const Results = lazy(() => import("./pages/Results.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const AuthPage = lazy(() => import("./pages/AuthPage.jsx"));

function App() {
  const { theme } = useTheme();
  return (
    <>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: theme === "dark" ? { background: "#253246", color: "#edf2fa", border: "1px solid #526075" } : {},
        }}
      />

      <Suspense fallback={<main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 text-sm font-medium text-slate-600" role="status">Loading SkyScout…</main>}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />

        <Route
          path="/results"
          element={<Results />}
        />

        <Route
          path="/dashboard"
          element={<RequireAuth><Dashboard /></RequireAuth>}
        />

        <Route
          path="/alerts"
          element={<Navigate to="/dashboard" replace />}
        />

        <Route
          path="/saved"
          element={<Navigate to="/dashboard" replace />}
        />

        <Route
          path="/history"
          element={<Navigate to="/dashboard" replace />}
        />

        <Route
          path="/trends"
          element={<Navigate to="/dashboard" replace />}
        />

        <Route
          path="/explore"
          element={<Navigate to="/dashboard" replace />}
        />

        <Route
          path="/profile"
          element={<Navigate to="/dashboard" replace />}
        />

        <Route
          path="/settings"
          element={<Navigate to="/dashboard" replace />}
        />

        <Route
          path="*"
          element={<Navigate to="/" replace />}
        />
      </Routes>
      </Suspense>
    </>
  );
}

export default App;
