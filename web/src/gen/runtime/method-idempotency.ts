// Temporary shim until protobuf-es exposes MethodIdempotency in the public API.
// Matches the values expected by connect-es generated clients.
export enum MethodIdempotency {
  Unknown = 0,
  NoSideEffects = 1,
  Idempotent = 2,
}

