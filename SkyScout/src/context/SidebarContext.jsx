import { createContext, useContext, useState } from "react";

// A context hook and its provider belong together in this module.
/* eslint-disable react-refresh/only-export-components */

const SidebarContext = createContext();

export function SidebarProvider({ children }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <SidebarContext.Provider
      value={{
        isSidebarOpen,
        setIsSidebarOpen,
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
