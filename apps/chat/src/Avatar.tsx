import { iconSvg, type PublicAvatar } from "@traiblazer/appearance";

/** The assistant's picture: uploaded photo, built-in icon, or initials. Decorative (name is shown as text). */
export function Avatar({ avatar, size = 36 }: { avatar: PublicAvatar; size?: number }) {
  const style = { width: `${size}px`, height: `${size}px` };
  if (avatar.kind === "image") {
    return <img class="tb-avatar" src={avatar.url} alt="" width={size} height={size} style={style} />;
  }
  if (avatar.kind === "icon") {
    return (
      <span
        class="tb-avatar tb-avatar-icon"
        style={style}
        aria-hidden="true"
        // Static, trusted SVG from @traiblazer/appearance (the id is validated server-side).
        dangerouslySetInnerHTML={{ __html: iconSvg(avatar.icon, Math.round(size * 0.55)) }}
      />
    );
  }
  return (
    <span
      class="tb-avatar tb-avatar-initials"
      style={{ ...style, fontSize: `${Math.round(size * 0.4)}px` }}
      aria-hidden="true"
    >
      {avatar.initials}
    </span>
  );
}
