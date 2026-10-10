import { createContext } from "react";
import type { RealtimeSocket } from "./RealtimeClient";

/**
 * The socket the channel hooks subscribe through. `null` (the default) is the
 * tab's own `RealtimeClient`, created on first use in the browser; `<Page>`
 * in `gemi/testing` provides a `FakeSocket`.
 */
export const RealtimeContext = createContext<RealtimeSocket | null>(null);
