import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/syntax.css";
import App from "./app/App";
import { bootstrapAppearance } from "./app/applyAppearance";
import { bootstrapShortcuts } from "./app/bootstrapShortcuts";

bootstrapAppearance();
bootstrapShortcuts();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
