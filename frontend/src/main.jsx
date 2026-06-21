// Bootstraps the SSO token bridge BEFORE React mounts. The module's
// side effect is to register a postMessage listener for MEETMIND_AUTH
// broadcasts and rehydrate any previously-stored token from
// localStorage. Anything that uses getToken() (the persistence hook,
// the useAuth hook) relies on this having run first, so keep it as
// the very first import in this file.
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
