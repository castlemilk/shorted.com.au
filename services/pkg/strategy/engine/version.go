package engine

// Version is the engine's version. It follows the rules of the strategy spec:
//
//   - a patch bumps it for a fix that changes any output of a registered spec;
//   - a minor bumps it for a new capability with no output change;
//   - a major bumps it for a semantic change, which also changes every spec's
//     hash (spec.EngineMajor).
//
// TestEngineVersionBumpedWithGoldens fails when the spec goldens change without
// this version changing.
const Version = "1.0.0"

// Major is the major component of Version.
const Major = 1
