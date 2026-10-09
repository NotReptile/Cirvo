import "./styles.css";
import { bootstrapDesktopApp } from "./app/bootstrap";
import { installExternalLinks } from "./app/tauriLinks";

const container = document.querySelector<HTMLDivElement>("#app");

if (!container) {
  throw new Error("Missing #app container");
}

installExternalLinks();
bootstrapDesktopApp(container);
