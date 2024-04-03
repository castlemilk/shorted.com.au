// @generated by protoc-gen-es v1.8.0 with parameter "target=ts,import_extension=none"
// @generated from file stocks/v1alpha1/stocks.proto (package stocks.v1alpha1, syntax proto3)
/* eslint-disable */
// @ts-nocheck

import type { BinaryReadOptions, FieldList, JsonReadOptions, JsonValue, PartialMessage, PlainMessage } from "@bufbuild/protobuf";
import { Message, proto3, Timestamp } from "@bufbuild/protobuf";

/**
 * A Stock represents a single stock's metadata.
 *
 * @generated from message stocks.v1alpha1.Stock
 */
export class Stock extends Message<Stock> {
  /**
   * The stock code, e.g., "CBA", "ZIP", "PLS".
   *
   * @generated from field: string product_code = 1;
   */
  productCode = "";

  /**
   * The full name of the stock.
   *
   * @generated from field: string name = 2;
   */
  name = "";

  /**
   * @generated from field: float total_product_in_issue = 3;
   */
  totalProductInIssue = 0;

  /**
   * @generated from field: float reported_short_positions = 4;
   */
  reportedShortPositions = 0;

  /**
   * TODO(castlemilk): add more metadata here as needed
   *
   * @generated from field: float percentage_shorted = 5;
   */
  percentageShorted = 0;

  constructor(data?: PartialMessage<Stock>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "stocks.v1alpha1.Stock";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "product_code", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 2, name: "name", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 3, name: "total_product_in_issue", kind: "scalar", T: 2 /* ScalarType.FLOAT */ },
    { no: 4, name: "reported_short_positions", kind: "scalar", T: 2 /* ScalarType.FLOAT */ },
    { no: 5, name: "percentage_shorted", kind: "scalar", T: 2 /* ScalarType.FLOAT */ },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): Stock {
    return new Stock().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): Stock {
    return new Stock().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): Stock {
    return new Stock().fromJsonString(jsonString, options);
  }

  static equals(a: Stock | PlainMessage<Stock> | undefined, b: Stock | PlainMessage<Stock> | undefined): boolean {
    return proto3.util.equals(Stock, a, b);
  }
}

/**
 * TimeSeriesData represents time series data for a stock.
 *
 * @generated from message stocks.v1alpha1.TimeSeriesData
 */
export class TimeSeriesData extends Message<TimeSeriesData> {
  /**
   * The stock code.
   *
   * @generated from field: string product_code = 1;
   */
  productCode = "";

  /**
   * @generated from field: string name = 3;
   */
  name = "";

  /**
   * The latest short position.
   *
   * @generated from field: double latest_short_position = 4;
   */
  latestShortPosition = 0;

  /**
   * The time series points.
   *
   * @generated from field: repeated stocks.v1alpha1.TimeSeriesPoint points = 10;
   */
  points: TimeSeriesPoint[] = [];

  constructor(data?: PartialMessage<TimeSeriesData>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "stocks.v1alpha1.TimeSeriesData";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "product_code", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 3, name: "name", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 4, name: "latest_short_position", kind: "scalar", T: 1 /* ScalarType.DOUBLE */ },
    { no: 10, name: "points", kind: "message", T: TimeSeriesPoint, repeated: true },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): TimeSeriesData {
    return new TimeSeriesData().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): TimeSeriesData {
    return new TimeSeriesData().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): TimeSeriesData {
    return new TimeSeriesData().fromJsonString(jsonString, options);
  }

  static equals(a: TimeSeriesData | PlainMessage<TimeSeriesData> | undefined, b: TimeSeriesData | PlainMessage<TimeSeriesData> | undefined): boolean {
    return proto3.util.equals(TimeSeriesData, a, b);
  }
}

/**
 * TimeSeriesPoint represents a single point in time for the time series data.
 *
 * @generated from message stocks.v1alpha1.TimeSeriesPoint
 */
export class TimeSeriesPoint extends Message<TimeSeriesPoint> {
  /**
   * The point in time.
   *
   * @generated from field: google.protobuf.Timestamp timestamp = 1;
   */
  timestamp?: Timestamp;

  /**
   * The short position at this point in time.
   *
   * @generated from field: double short_position = 2;
   */
  shortPosition = 0;

  constructor(data?: PartialMessage<TimeSeriesPoint>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "stocks.v1alpha1.TimeSeriesPoint";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "timestamp", kind: "message", T: Timestamp },
    { no: 2, name: "short_position", kind: "scalar", T: 1 /* ScalarType.DOUBLE */ },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): TimeSeriesPoint {
    return new TimeSeriesPoint().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): TimeSeriesPoint {
    return new TimeSeriesPoint().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): TimeSeriesPoint {
    return new TimeSeriesPoint().fromJsonString(jsonString, options);
  }

  static equals(a: TimeSeriesPoint | PlainMessage<TimeSeriesPoint> | undefined, b: TimeSeriesPoint | PlainMessage<TimeSeriesPoint> | undefined): boolean {
    return proto3.util.equals(TimeSeriesPoint, a, b);
  }
}

/**
 * @generated from message stocks.v1alpha1.StockDetails
 */
export class StockDetails extends Message<StockDetails> {
  /**
   * @generated from field: string product_code = 1;
   */
  productCode = "";

  /**
   * @generated from field: string name = 2;
   */
  name = "";

  /**
   * @generated from field: string description = 3;
   */
  description = "";

  /**
   * @generated from field: string sector = 7;
   */
  sector = "";

  /**
   * @generated from field: stocks.v1alpha1.TimeSeriesData time_series_data = 4;
   */
  timeSeriesData?: TimeSeriesData;

  constructor(data?: PartialMessage<StockDetails>) {
    super();
    proto3.util.initPartial(data, this);
  }

  static readonly runtime: typeof proto3 = proto3;
  static readonly typeName = "stocks.v1alpha1.StockDetails";
  static readonly fields: FieldList = proto3.util.newFieldList(() => [
    { no: 1, name: "product_code", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 2, name: "name", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 3, name: "description", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 7, name: "sector", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 4, name: "time_series_data", kind: "message", T: TimeSeriesData },
  ]);

  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): StockDetails {
    return new StockDetails().fromBinary(bytes, options);
  }

  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): StockDetails {
    return new StockDetails().fromJson(jsonValue, options);
  }

  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): StockDetails {
    return new StockDetails().fromJsonString(jsonString, options);
  }

  static equals(a: StockDetails | PlainMessage<StockDetails> | undefined, b: StockDetails | PlainMessage<StockDetails> | undefined): boolean {
    return proto3.util.equals(StockDetails, a, b);
  }
}

