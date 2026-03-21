import React from "react";
import { createRoot } from "react-dom/client";
import ViewerApp from "./ViewerApp";

const rootEl = document.getElementById("viewerRoot");
if (!rootEl) {
  throw new Error("viewerRoot mount node not found");
}

createRoot(rootEl).render(
  <React.StrictMode>
    <ViewerApp />
  </React.StrictMode>
);
