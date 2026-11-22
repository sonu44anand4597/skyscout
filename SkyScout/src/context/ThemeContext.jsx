import { useState } from "react";
import { ThemeContext, readTheme, applyTheme } from "./theme.js";

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readTheme);
  const setAndApply = (next) => { applyTheme(next); setTheme(next); };
  return <ThemeContext.Provider value={{ theme, setTheme: setAndApply }}>{children}</ThemeContext.Provider>;
}
