import { safeExternalHref } from "~/@/lib/safe-external-href";

/**
 * A markdown image in an assistant reply, shown as a link the reader can choose
 * to open. It is never fetched: the URL is model-written, and tool data (news
 * items, scraped announcements) can steer the model into a URL that carries the
 * person's question or conversation. A fetched image would send that the moment
 * the reply rendered, with no click. Streamdown's own defaults allow any host.
 *
 * It lives apart from message-response.tsx, which imports the ESM-only Streamdown
 * packages, so it can be tested in plain jest.
 */
// Streamdown types its element overrides as index-signature props, so this takes
// the same shape: a props type with only optional keys is a weak type, and that
// does not accept them.
export function MessageImage(props: Record<string, unknown>) {
  const { src, alt } = props;
  const label = (typeof alt === "string" && alt.trim()) || "Image";
  const href = safeExternalHref(src);
  if (!href) {
    return <span>{label}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className="underline underline-offset-2"
    >
      {label}
    </a>
  );
}
