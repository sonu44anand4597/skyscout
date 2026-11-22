import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { SidebarProvider } from "./context/SidebarContext";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <BrowserRouter>
  <ThemeProvider>
  <SidebarProvider>
    <AuthProvider>
      <App />
    </AuthProvider>
  </SidebarProvider>
  </ThemeProvider>
</BrowserRouter>
);
