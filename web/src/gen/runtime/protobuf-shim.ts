// Re-export everything from @bufbuild/protobuf and add MethodIdempotency shim
export * from "@bufbuild/protobuf";

// Export MethodIdempotency enum that connect-web expects
export enum MethodIdempotency {
  Unknown = 0,
  NoSideEffects = 1,
  Idempotent = 2,
}

