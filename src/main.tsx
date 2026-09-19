import React from "react";
import ReactDOM from "react-dom/client";
import Panel from "./panel/Panel";
import Settings from "./settings/Settings";
import "./styles.css";

// One bundle, two windows: the panel and the settings window.
const isSettings = new URLSearchParams(location.search).get("window") === "settings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isSettings ? <Settings /> : <Panel />}</React.StrictMode>,
);
