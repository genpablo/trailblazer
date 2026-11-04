import { render } from "preact";
import { App, type AppProps } from "./App";
import "./styles.css";

const publicKey = decodeURIComponent(window.location.pathname.split("/").filter(Boolean)[1] ?? "");
const params = new URLSearchParams(window.location.search);
const embed = params.get("embed");
const mode: AppProps["mode"] =
  embed === "widget" || embed === "inline" || embed === "playground" ? embed : "hosted";
const page = params.get("page");
const preview = params.get("preview") === "1";

render(
  <App publicKey={publicKey} mode={mode} pageUrl={page} preview={preview} />,
  document.getElementById("app")!,
);
