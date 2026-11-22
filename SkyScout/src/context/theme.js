import { createContext, useContext } from "react";

export const ThemeContext = createContext(null);
const STORAGE_KEY = "skyscout-theme";

export function readTheme() {
  try { return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light"; }
  catch { return "light"; }
}

export function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* storage may be disabled */ }
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme requires ThemeProvider");
  return context;
}
