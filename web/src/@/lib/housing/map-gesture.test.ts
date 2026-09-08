import { gestureCss, gestureIsIdentity } from "./map-gesture";

describe("gestureCss", () => {
  test("a pure pan is a translate by the delta", () => {
    expect(gestureCss({ k: 2, x: 10, y: 20 }, { k: 2, x: 40, y: 25 })).toBe("translate(30px, 5px) scale(1)");
  });

  test("a zoom about the origin composes as scale then corrected translate", () => {
    // committed: k=1,t=(0,0); live: k=2,t=(-100,-50) → screen = 2·world − (100,50)
    expect(gestureCss({ k: 1, x: 0, y: 0 }, { k: 2, x: -100, y: -50 })).toBe("translate(-100px, -50px) scale(2)");
  });

  test("the CSS transform reproduces the live mapping of a world point", () => {
    const committed = { k: 3, x: 120, y: -40 };
    const live = { k: 4.5, x: 30, y: 15 };
    const css = gestureCss(committed, live);
    const [, dx, dy, s] = css.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)!.map(Number);
    const world = { x: 57, y: 91 };
    const committedScreen = { x: committed.k * world.x + committed.x, y: committed.k * world.y + committed.y };
    const viaCss = { x: s! * committedScreen.x + dx!, y: s! * committedScreen.y + dy! };
    const liveScreen = { x: live.k * world.x + live.x, y: live.k * world.y + live.y };
    expect(viaCss.x).toBeCloseTo(liveScreen.x, 1);
    expect(viaCss.y).toBeCloseTo(liveScreen.y, 1);
  });

  test("identity is detected so the composited layer can be dropped", () => {
    expect(gestureIsIdentity({ k: 2, x: 1, y: 1 }, { k: 2, x: 1, y: 1 })).toBe(true);
    expect(gestureIsIdentity({ k: 2, x: 1, y: 1 }, { k: 2.1, x: 1, y: 1 })).toBe(false);
  });
});
