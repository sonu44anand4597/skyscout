import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { apiRequest } from "../api/client.js";
import { resultsCache } from '../utils/resultsCache.js';

const AuthContext = createContext(null);
/* eslint-disable react-refresh/only-export-components */

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const sessionVersion = useRef(0);
  const refreshUser = useCallback(async () => {
    const version = ++sessionVersion.current;
    setLoading(true);
    setSessionError('');
    try {
      const response = await apiRequest("/auth/me");
      if (version === sessionVersion.current) setUser(response.user);
      return response.user;
    } catch (error) {
      if (version === sessionVersion.current) {
        if (error.status === 401) setUser(null);
        else setSessionError(error.message);
      }
      return null;
    } finally { if (version === sessionVersion.current) setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(refreshUser, 0);
    return () => clearTimeout(timer);
  }, [refreshUser]);

  const signIn = async (credentials, isRegistration = false) => {
    const response = await apiRequest(isRegistration ? "/auth/register" : "/auth/login", { method: "POST", body: credentials });
    ++sessionVersion.current;
    setUser(response.user); setSessionError(''); setLoading(false);
    return response.user;
  };
  const signOut = async () => {
    await apiRequest("/auth/logout", { method: "POST" });
    ++sessionVersion.current;
    resultsCache.clear();
    setUser(null); setSessionError(''); setLoading(false);
  };

  return <AuthContext.Provider value={{ user, loading, sessionError, signIn, signOut, refreshUser }}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }
