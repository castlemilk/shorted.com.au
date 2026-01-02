declare module "three" {
  export class Uniform<T = unknown> {
    value: T;
    constructor(value: T);
  }

  export class Vector2 {
    x: number;
    y: number;
    constructor(x?: number, y?: number);
    set(x: number, y: number): this;
    copy(v: Vector2): this;
  }

  export class Color {
    constructor(r?: number, g?: number, b?: number);
    set(r: number, g: number, b: number): this;
  }

  // Enough for `useRef<THREE.Mesh>(null)`; we don't need the full Mesh surface area.
  export type Mesh = unknown;
}


