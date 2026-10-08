import { useEffect } from "react";

/**
 * An island with an effect to clean up, like a menu's scroll lock: while it is
 * mounted, `<html data-locked>` is set.
 */
export default function ScrollLock(props: { label: string }) {
  useEffect(() => {
    document.documentElement.dataset.locked = props.label;
    return () => {
      delete document.documentElement.dataset.locked;
    };
  }, [props.label]);
  return <span className="lock">{props.label}</span>;
}
