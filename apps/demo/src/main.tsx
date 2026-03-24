import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { BrowserBenchPage } from "./browser-bench";
import "./styles.css";
import "./ag-grid-shell.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Missing #root container");
}

const path = window.location.pathname;

createRoot(rootElement).render(
  <StrictMode>
    {path === "/bench" ? <BrowserBenchPage /> : <App />}
  </StrictMode>,
);
