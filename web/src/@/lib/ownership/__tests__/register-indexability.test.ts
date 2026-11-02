import { registerIsIndexable } from "../register-indexability";

describe("registerIsIndexable", () => {
  it("indexes a register that names at least one current holder", () => {
    expect(registerIsIndexable({ holders: 1 })).toBe(true);
    expect(registerIsIndexable({ holders: 12 })).toBe(true);
  });

  // An all-ceased register still draws its lanes; it just does not rank.
  it("noindexes a register with no current holder", () => {
    expect(registerIsIndexable({ holders: 0 })).toBe(false);
  });
});
