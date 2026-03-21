import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import "./styles.css";
import "./ag-grid-shell.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Missing #root container");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
