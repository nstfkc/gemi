/**
 * `gemi/ai/voice` — the browser half of voice calls to an agent (#921).
 *
 * An entry of its own, beside `gemi/ai/client`, so an app that never uses
 * voice never bundles it, and an app that does gets it in the chunk of the view
 * (or the dynamically imported component) that uses it, never in the entry
 * chunk every route loads. The packaging test checks that.
 *
 * One module graph rather than a hook plus a further `import()` for the peer
 * connection: the whole entry is a few kilobytes and is already only loaded
 * where it is used, so a second split would add a request for no saving. It
 * also imports nothing from `gemi/client` (not even `useParams`), because a
 * module both share would be moved out of the app's entry chunk into a shared
 * chunk that every route then loads.
 *
 * Like `gemi/ai/client`, nothing here reaches the server half: `useVoiceSession`
 * talks to the app's `this.voice(Controller)` route, which holds the vendor
 * key. The server half (`VoiceBridge`, `VoiceConfig`) is in `gemi/ai`.
 */

export { useVoiceSession } from "./useVoiceSession";
export type { UseVoiceSessionParams, UseVoiceSessionResult } from "./useVoiceSession";
export type { VoiceCaption, VoiceStatus } from "./wire";
