import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { applyTheme, readTheme } from "./theme.ts";
import "./fonts.css";
import "./styles.css";

// Light or dark as chosen in More, before the first paint.
applyTheme(readTheme(), false);

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
