import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import Hud from "./Hud";
import Outline from "./Outline";
import "@fontsource-variable/google-sans-flex/wght.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("KnowHow Capture could not initialize.");

const windowLabel = getCurrentWindow().label;
document.documentElement.dataset.window = windowLabel;
document.body.dataset.window = windowLabel;
const WindowApp =
  windowLabel === "hud" ? Hud : windowLabel === "outline" ? Outline : App;

createRoot(root).render(
  <StrictMode>
    <WindowApp />
  </StrictMode>,
);
