// gemi/ai/testing: model-backed tests and evals without a live model.
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
export { pinClock } from "./pinClock";
