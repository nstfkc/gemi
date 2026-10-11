/**
 * The request header a client sends its socket id in, for `toOthers`.
 *
 * A module of its own, re-exported by `./protocol`: every mutation in the
 * browser reads it, and anything else in `./protocol` it pulled along would
 * land in every route's entry chunk instead of the lazily loaded socket's.
 */
export const SOCKET_ID_HEADER = "x-gemi-socket";
