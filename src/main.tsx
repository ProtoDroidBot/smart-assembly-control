import React from "react";
import ReactDOM from "react-dom/client";
import "./main.css";

import App from "./App.tsx";
import { loadRuntimeConfig } from "./assembly/runtime-config.ts";

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<p role="status">Loading world configuration…</p>);
void loadRuntimeConfig(import.meta.env).then(({ env, error }) => {
  root.render(
    <React.StrictMode>
      <App env={env} configurationError={error} />
    </React.StrictMode>,
  );
});
