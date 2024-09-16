// @generated by protoc-gen-connect-es v1.4.0 with parameter "target=ts,import_extension=none"
// @generated from file register/v1/register.proto (package register.v1, syntax proto3)
/* eslint-disable */
// @ts-nocheck

import { RegisterEmailRequest, RegisterEmailResponse } from "./register_pb";
import { MethodKind } from "@bufbuild/protobuf";

/**
 * @generated from service register.v1.RegisterService
 */
export const RegisterService = {
  typeName: "register.v1.RegisterService",
  methods: {
    /**
     * Register an email address to receive updates.
     *
     * @generated from rpc register.v1.RegisterService.RegisterEmail
     */
    registerEmail: {
      name: "RegisterEmail",
      I: RegisterEmailRequest,
      O: RegisterEmailResponse,
      kind: MethodKind.Unary,
    },
  }
} as const;

