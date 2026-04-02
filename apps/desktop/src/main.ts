import "./styles.css";
import { bootstrapDesktopApp } from "./app/bootstrap";

const container = document.querySelector<HTMLDivElement>("#app");

if (!container) {
  throw new Error("Missing #app container");
}

bootstrapDesktopApp(container);
