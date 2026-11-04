/**
 * Floating chat widget loader.
 *
 *   <script src="https://<chat-domain>/widget.js" data-bot="pk_live_…" async></script>
 *
 * Optional attributes: data-color="#1f6f5c", data-position="left", data-label="Chat with us".
 * Adds a launcher button; the chat itself loads in an iframe on first open, so the host page's
 * CSS and scripts can't interfere with it.
 */
(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  const key = script?.dataset.bot;
  if (!script || !key || (window as unknown as { __tbWidget?: boolean }).__tbWidget) return;
  (window as unknown as { __tbWidget?: boolean }).__tbWidget = true;

  const origin = new URL(script.src).origin;
  const color = /^#[0-9a-f]{3,8}$/i.test(script.dataset.color ?? "") ? script.dataset.color! : "#1f6f5c";
  const side = script.dataset.position === "left" ? "left" : "right";
  const label = script.dataset.label ?? "Chat";

  const host = document.createElement("div");
  host.setAttribute("data-traiblazer-widget", "");
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .launcher { position: fixed; bottom: 20px; ${side}: 20px; z-index: 2147483000; width: 56px; height: 56px;
        border-radius: 50%; border: 0; background: ${color}; color: #fff; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.25); display: flex; align-items: center; justify-content: center; }
      .launcher:focus-visible { outline: 3px solid ${color}; outline-offset: 3px; }
      .panel { position: fixed; bottom: 88px; ${side}: 20px; z-index: 2147483000; width: 380px; height: 600px;
        max-height: calc(100vh - 108px); border-radius: 14px; overflow: hidden; display: none;
        box-shadow: 0 8px 32px rgba(0,0,0,.28); background: #fff; }
      .panel.open { display: block; }
      iframe { width: 100%; height: 100%; border: 0; }
      @media (max-width: 480px) {
        .panel { inset: 0; width: 100%; height: 100%; max-height: none; border-radius: 0; bottom: 0; ${side}: 0; }
        .panel.open + .launcher { display: none; }
      }
    </style>
    <div class="panel" role="dialog" aria-label="${label.replace(/"/g, "&quot;")}"></div>
    <button class="launcher" type="button" aria-expanded="false" aria-label="${label.replace(/"/g, "&quot;")}">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </button>`;

  const panel = shadow.querySelector(".panel") as HTMLDivElement;
  const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;
  let frame: HTMLIFrameElement | null = null;

  const setOpen = (open: boolean) => {
    if (open && !frame) {
      frame = document.createElement("iframe");
      const page = encodeURIComponent(location.href.slice(0, 1000));
      frame.src = `${origin}/c/${encodeURIComponent(key)}?embed=widget&page=${page}`;
      frame.title = label;
      frame.allow = "clipboard-write";
      panel.appendChild(frame);
    }
    panel.classList.toggle("open", open);
    launcher.setAttribute("aria-expanded", String(open));
    if (open) frame?.focus();
  };

  launcher.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  window.addEventListener("message", (event) => {
    if (event.origin === origin && (event.data as { type?: string })?.type === "tb:close") {
      setOpen(false);
      launcher.focus();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("open")) setOpen(false);
  });

  (document.body ?? document.documentElement).appendChild(host);
})();
