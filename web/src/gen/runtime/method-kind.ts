// Temporary shim until protobuf-es exposes MethodKind in the public API.
// Matches the values expected by connect-es generated clients.
export enum MethodKind {
  Unary = 0,
  ServerStreaming = 1,
  ClientStreaming = 2,
  BiDiStreaming = 3,
}

