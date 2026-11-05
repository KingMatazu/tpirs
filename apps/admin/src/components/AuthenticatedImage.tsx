import { useEffect, useState, type ReactElement } from "react";
import { apiUrl } from "../api/client.js";
import { useSession } from "../session.js";

/**
 * An image behind the API's permission wall.
 *
 * `<img src="/v1/assets/…/photos/…">` cannot work: the access token lives in
 * memory, and an image request carries no `Authorization` header, so the API
 * answers 401 and the browser renders a broken image. The photo has to be
 * fetched with the bearer and handed to the element as an object URL.
 *
 * The same mistake is easy to make with a sticker or an export, which is why this
 * is a component rather than a line in one page.
 */
export function AuthenticatedImage(
  props: Readonly<{
    src: string;
    alt: string;
    className?: string;
  }>,
): ReactElement {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;

    const token = useSession.getState().accessToken;
    void fetch(apiUrl(props.src), {
      headers: token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`photo ${String(response.status)}`);
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [props.src]);

  if (failed) {
    return (
      <span
        className={`flex items-center justify-center rounded border border-slate-200 bg-slate-50 text-xs text-slate-500 ${props.className ?? ""}`}
      >
        Photo unavailable
      </span>
    );
  }
  if (url === undefined) {
    return (
      <span
        className={`block animate-pulse rounded border border-slate-200 bg-slate-100 ${props.className ?? ""}`}
        aria-hidden="true"
      />
    );
  }
  return <img src={url} alt={props.alt} className={props.className} />;
}
