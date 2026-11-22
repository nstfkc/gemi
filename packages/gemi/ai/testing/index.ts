// gemi/ai/testing: model-backed tests and evals without a live model.
//
// `scriptedProvider` answers each agent's calls from a script of its own, and
// `turnOf` finds the user turn a call answers.
//
// `RecordingProvider` records a live provider's calls and replays them, with
// tolerant matching, sub-runs, upload ids and the ids a run mints. See
// docs/ai-testing.md.
export {
  type RecordedCall,
  type RecordedRequest,
  type Recording,
  type RecordingMatch,
  RecordingMismatchError,
  RecordingProvider,
  type RecordingProviderOptions,
} from "./RecordingProvider";
export { type FingerprintOptions, Fingerprints, type RecordingFingerprints } from "./Fingerprints";
export { pinClock } from "./pinClock";
export {
  type ScriptedCall,
  ScriptedProvider,
  ScriptedProviderError,
  type ScriptedProviderOptions,
  type ScriptedReply,
  type ScriptedStep,
  type ScriptedTurn,
  scriptedProvider,
  turnOf,
} from "./scriptedProvider";
