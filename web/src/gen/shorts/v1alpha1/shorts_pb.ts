// @generated by protoc-gen-es v1.8.0 with parameter "target=ts,import_extension=none"
// @generated from file shorts/v1alpha1/shorts.proto (package shorts.v1alpha1, syntax proto3)
/* eslint-disable */
// @ts-nocheck

import type { BinaryReadOptions, FieldList, JsonReadOptions, JsonValue, PartialMessage, PlainMessage } from "@bufbuild/protobuf";
import { Message, proto3 } from "@bufbuild/protobuf";
import { TimeSeriesData } from "../../stocks/v1alpha1/stocks_pb";

/**
 * Request for Top10 RPC, specifying the period of time.
 *
 * @generated from message shorts.v1alpha1.GetTopShortsRequest
 */
export class GetTopShortsRequest extends Message<GetTopShortsRequest> {
  /**
   * @generated from field: string period = 1;
   */
  period = "";

  /**
   * @generated from field: int32 limit = 2;
   */
  limit = 0;

  constructor(data?: PartialMessage<GetTopShortsRequest>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "shorts.v1alpha1.GetTopShortsRequest";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "period", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 2, name: "limit", kind: "scalar", T: 5 /* ScalarType.INT32 */ },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): GetTopShortsRequest {
    return new GetTopShortsRequest().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): GetTopShortsRequest {
    return new GetTopShortsRequest().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): GetTopShortsRequest {
    return new GetTopShortsRequest().fromJsonString(jsonString, options);
  }

  static equals(a: GetTopShortsRequest | PlainMessage<GetTopShortsRequest> | undefined, b: GetTopShortsRequest | PlainMessage<GetTopShortsRequest> | undefined): boolean {
    return proto3.util.equals(GetTopShortsRequest, a, b);
  }
}

/**
 * Response for Top10 RPC, including time series data for each of the top 10 short positions.
 *
 * @generated from message shorts.v1alpha1.GetTopShortsResponse
 */
export class GetTopShortsResponse extends Message<GetTopShortsResponse> {
  /**
   * @generated from field: repeated stocks.v1alpha1.TimeSeriesData time_series = 1;
   */
  timeSeries: TimeSeriesData[] = [];

  constructor(data?: PartialMessage<GetTopShortsResponse>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "shorts.v1alpha1.GetTopShortsResponse";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "time_series", kind: "message", T: TimeSeriesData, repeated: true },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): GetTopShortsResponse {
    return new GetTopShortsResponse().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): GetTopShortsResponse {
    return new GetTopShortsResponse().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): GetTopShortsResponse {
    return new GetTopShortsResponse().fromJsonString(jsonString, options);
  }

  static equals(a: GetTopShortsResponse | PlainMessage<GetTopShortsResponse> | undefined, b: GetTopShortsResponse | PlainMessage<GetTopShortsResponse> | undefined): boolean {
    return proto3.util.equals(GetTopShortsResponse, a, b);
  }
}

/**
 * Request for GetStockSummary RPC, specifying the product code.
 *
 * @generated from message shorts.v1alpha1.GetStockRequest
 */
export class GetStockRequest extends Message<GetStockRequest> {
  /**
   * @generated from field: string product_code = 1;
   */
  productCode = "";

  constructor(data?: PartialMessage<GetStockRequest>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "shorts.v1alpha1.GetStockRequest";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "product_code", kind: "scalar", T: 9 /* ScalarType.STRING */ },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): GetStockRequest {
    return new GetStockRequest().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): GetStockRequest {
    return new GetStockRequest().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): GetStockRequest {
    return new GetStockRequest().fromJsonString(jsonString, options);
  }

  static equals(a: GetStockRequest | PlainMessage<GetStockRequest> | undefined, b: GetStockRequest | PlainMessage<GetStockRequest> | undefined): boolean {
    return proto3.util.equals(GetStockRequest, a, b);
  }
}

/**
 * Request for GetStockDetails RPC, specifying the product code.
 *
 * @generated from message shorts.v1alpha1.GetStockDetailsRequest
 */
export class GetStockDetailsRequest extends Message<GetStockDetailsRequest> {
  /**
   * @generated from field: string product_code = 1;
   */
  productCode = "";

  constructor(data?: PartialMessage<GetStockDetailsRequest>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "shorts.v1alpha1.GetStockDetailsRequest";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "product_code", kind: "scalar", T: 9 /* ScalarType.STRING */ },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): GetStockDetailsRequest {
    return new GetStockDetailsRequest().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): GetStockDetailsRequest {
    return new GetStockDetailsRequest().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): GetStockDetailsRequest {
    return new GetStockDetailsRequest().fromJsonString(jsonString, options);
  }

  static equals(a: GetStockDetailsRequest | PlainMessage<GetStockDetailsRequest> | undefined, b: GetStockDetailsRequest | PlainMessage<GetStockDetailsRequest> | undefined): boolean {
    return proto3.util.equals(GetStockDetailsRequest, a, b);
  }
}

/**
 * Request for GetStockDataRequest RPC, specifying the product code.
 *
 * @generated from message shorts.v1alpha1.GetStockDataRequest
 */
export class GetStockDataRequest extends Message<GetStockDataRequest> {
  /**
   * @generated from field: string product_code = 1;
   */
  productCode = "";

  constructor(data?: PartialMessage<GetStockDataRequest>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "shorts.v1alpha1.GetStockDataRequest";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "product_code", kind: "scalar", T: 9 /* ScalarType.STRING */ },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): GetStockDataRequest {
    return new GetStockDataRequest().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): GetStockDataRequest {
    return new GetStockDataRequest().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): GetStockDataRequest {
    return new GetStockDataRequest().fromJsonString(jsonString, options);
  }

  static equals(a: GetStockDataRequest | PlainMessage<GetStockDataRequest> | undefined, b: GetStockDataRequest | PlainMessage<GetStockDataRequest> | undefined): boolean {
    return proto3.util.equals(GetStockDataRequest, a, b);
  }
}

