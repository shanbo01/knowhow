import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import Hud from "./Hud";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("KnowHow Capture could not initialize.");

const WindowApp = getCurrentWindow().label === "hud" ? Hud : App;

createRoot(root).render(
  <StrictMode>
    <WindowApp />
  </StrictMode>,
);
