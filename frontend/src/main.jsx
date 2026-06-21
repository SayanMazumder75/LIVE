// MUST stay the first import — registers the postMessage SSO listener
// on `window` BEFORE any React render. Without this ordering, a
// `MEETMIND_AUTH` message arriving during the first frame can be
// dropped, leaving the user permanently unauthenticated until they
// reload.
import "./auth.js";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
