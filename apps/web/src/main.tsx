import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AuthProvider } from "./auth-context";
import { CurrencyBootstrap } from "./bootstrap";
import { App } from "./app";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <CurrencyBootstrap>
        <AuthProvider>
          <App />
        </AuthProvider>
      </CurrencyBootstrap>
    </BrowserRouter>
  </React.StrictMode>,
);
