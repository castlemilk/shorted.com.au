// Mock for d3-scale (ESM-only module that Jest can't parse without extra
// transform config). Provides minimal functional stubs — enough for pure
// helpers that build a color scale to run under Jest without needing the
// real interpolation math (colors aren't asserted in these unit tests).

const makeSequential = (interpolator) => {
  let domain = [0, 1];
  const scale = (v) => {
    const [d0, d1] = domain;
    const t = d1 === d0 ? 0 : (v - d0) / (d1 - d0);
    return interpolator(Math.max(0, Math.min(1, t)));
  };
  scale.domain = (d) => {
    if (d) {
      domain = d;
      return scale;
    }
    return domain;
  };
  return scale;
};

const scaleSequential = (interpolator) => makeSequential(interpolator);
const scaleSequentialSqrt = (interpolator) => makeSequential(interpolator);

const scaleDiverging = (domain, interpolator) => {
  const [d0, d1, d2] = domain;
  const scale = (v) => {
    const t = v <= d1 ? (v - d0) / ((d1 - d0) || 1) / 2 : 0.5 + (v - d1) / ((d2 - d1) || 1) / 2;
    return interpolator(Math.max(0, Math.min(1, t)));
  };
  return scale;
};

module.exports = { scaleSequential, scaleSequentialSqrt, scaleDiverging };
