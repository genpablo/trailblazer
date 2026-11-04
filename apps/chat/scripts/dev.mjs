// Rebuilds the chat page and the widget loader on change; the API serves the output from dist/.
import { build } from "vite";

const watch = {};
await build({ configFile: "vite.config.ts", build: { watch } });
await build({ configFile: "vite.widget.config.ts", build: { watch } });
