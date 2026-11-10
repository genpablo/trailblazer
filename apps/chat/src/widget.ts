/**
 * Floating chat widget loader.
 *
 *   <script src="https://<chat-domain>/widget.js" data-bot="pk_live_…" async></script>
 *
 * The launcher follows the business's appearance settings (color, avatar, label, side), fetched
 * from the public config, so changes in the admin apply without re-pasting the snippet.
 * Optional overrides: data-color, data-position="left", data-label. The chat itself loads in an
 * iframe on first open, so the host page's CSS and scripts can't interfere with it.
 */
import { DEFAULT_COLOR, iconSvg, isHexColor, type PublicAppearance, textOn } from "@traiblazer/appearance";

(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  const key = script?.dataset.bot;
  const w = window as unknown as { __tbWidget?: boolean };
  if (!script || !key || w.__tbWidget) return;
  w.__tbWidget = true;
  const origin = new URL(script.src).origin;

  const escapeHtml = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );

  function mount(appearance: Partial<PublicAppearance>) {
    const attrColor = script!.dataset.color;
    const color =
      attrColor && isHexColor(attrColor)
        ? attrColor
        : appearance.color && isHexColor(appearance.color)
          ? appearance.color
          : DEFAULT_COLOR;
    const onColor = textOn(color);
    const side = (script!.dataset.position ?? appearance.launcherPosition) === "left" ? "left" : "right";
    const label = script!.dataset.label ?? appearance.launcherLabel ?? "";
    const title = appearance.assistantName || label || "Chat";
    const closeLabel = /^fr\b/i.test(document.documentElement.lang || navigator.language)
      ? "Fermer"
      : "Close";
    const avatar = appearance.avatar;
    const imageUrl = avatar?.kind === "image" && avatar.url.startsWith(`${origin}/`) ? avatar.url : null;
    const iconMarkup = imageUrl
      ? `<img src="${escapeHtml(imageUrl)}" alt="" width="40" height="40">`
      : iconSvg(avatar?.kind === "icon" ? avatar.icon : "chat", 26);

    const host = document.createElement("div");
    host.setAttribute("data-traiblazer-widget", "");
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .launcher { position: fixed; bottom: 20px; ${side}: 20px; z-index: 2147483000; height: 56px; min-width: 56px;
        border-radius: 28px; border: 0; background: ${color}; color: ${onColor}; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.25); display: flex; align-items: center; justify-content: center;
        gap: 8px; padding: ${label ? "0 18px 0 8px" : "0"}; font: 600 15px system-ui, sans-serif; }
      .launcher img { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
      .launcher svg { flex-shrink: 0; }
      .launcher:focus-visible { outline: 3px solid ${color}; outline-offset: 3px; }
      .panel { position: fixed; bottom: 88px; ${side}: 20px; z-index: 2147483000; width: 380px; height: 600px;
        max-height: calc(100vh - 108px); border-radius: 14px; overflow: hidden; display: none;
        box-shadow: 0 8px 32px rgba(0,0,0,.28); background: #fff; }
      .panel.open { display: block; }
      iframe { width: 100%; height: 100%; border: 0; }
      /* Shown until the chat page says it is ready: if the page never loads (blocked, offline,
         unavailable) the visitor can still close the panel, which covers the screen on phones. */
      .close { position: absolute; top: 8px; inset-inline-end: 8px; width: 40px; height: 40px; border: 0;
        border-radius: 50%; background: rgba(0,0,0,.06); color: #333; cursor: pointer;
        font: 400 24px/1 system-ui, sans-serif; }
      .close:focus-visible { outline: 3px solid ${color}; outline-offset: 2px; }
      .panel.ready .close { display: none; }
      @media (max-width: 480px) {
        .panel { inset: 0; width: 100%; height: 100%; max-height: none; border-radius: 0; bottom: 0; ${side}: 0; }
        .panel.open + .launcher { display: none; }
      }
    </style>
    <div class="panel" role="dialog" aria-label="${escapeHtml(title)}">
      <button class="close" type="button" aria-label="${closeLabel}">×</button>
    </div>
    <button class="launcher" type="button" aria-expanded="false" aria-label="${escapeHtml(label || title)}">
      ${iconMarkup}${label ? `<span>${escapeHtml(label)}</span>` : ""}
    </button>`;

    const panel = shadow.querySelector(".panel") as HTMLDivElement;
    const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;
    let frame: HTMLIFrameElement | null = null;

    const setOpen = (open: boolean) => {
      if (open && !frame) {
        frame = document.createElement("iframe");
        const page = encodeURIComponent(location.href.slice(0, 1000));
        frame.src = `${origin}/c/${encodeURIComponent(key!)}?embed=widget&page=${page}`;
        frame.title = title;
        frame.allow = "clipboard-write";
        panel.appendChild(frame);
      }
      panel.classList.toggle("open", open);
      launcher.setAttribute("aria-expanded", String(open));
      if (open) frame?.focus();
    };

    const close = () => {
      setOpen(false);
      launcher.focus();
    };
    launcher.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
    (shadow.querySelector(".close") as HTMLButtonElement).addEventListener("click", close);
    window.addEventListener("message", (event) => {
      // Only our own chat frame may drive the panel.
      if (event.origin !== origin || !frame || event.source !== frame.contentWindow) return;
      const type = (event.data as { type?: string } | null)?.type;
      if (type === "tb:ready") panel.classList.add("ready");
      else if (type === "tb:close") close();
    });
    // Escape pressed on the host page; inside the chat frame, the chat page sends tb:close itself.
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel.classList.contains("open")) close();
    });

    (document.body ?? document.documentElement).appendChild(host);
  }

  fetch(`${origin}/v1/public/bots/${encodeURIComponent(key)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { bot?: { appearance?: PublicAppearance } } | null) => {
      // Unknown or paused assistant: show nothing on the customer's site.
      if (data?.bot) mount(data.bot.appearance ?? {});
    })
    .catch(() => mount({}));
})();
