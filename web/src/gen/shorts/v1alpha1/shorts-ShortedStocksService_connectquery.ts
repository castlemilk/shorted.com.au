// @generated by protoc-gen-connect-query v1.3.1 with parameter "target=ts,import_extension=none"
// @generated from file shorts/v1alpha1/shorts.proto (package shorts.v1alpha1, syntax proto3)
/* eslint-disable */
// @ts-nocheck

import { MethodKind } from "@bufbuild/protobuf";
import { GetIndustryTreeMapRequest, GetStockDataRequest, GetStockDetailsRequest, GetStockRequest, GetTopShortsRequest, GetTopShortsResponse } from "./shorts_pb";
import { IndustryTreeMap, Stock, StockDetails, TimeSeriesData } from "../../stocks/v1alpha1/stocks_pb";

/**
 * Shows top 10 short positions on the ASX over different periods of time.
 *
 * @generated from rpc shorts.v1alpha1.ShortedStocksService.GetTopShorts
 */
export const getTopShorts = {
  localName: "getTopShorts",
  name: "GetTopShorts",
  kind: MethodKind.Unary,
  I: GetTopShortsRequest,
  O: GetTopShortsResponse,
  service: {
    typeName: "shorts.v1alpha1.ShortedStocksService"
  }
} as const;

/**
 * @generated from rpc shorts.v1alpha1.ShortedStocksService.GetIndustryTreeMap
 */
export const getIndustryTreeMap = {
  localName: "getIndustryTreeMap",
  name: "GetIndustryTreeMap",
  kind: MethodKind.Unary,
  I: GetIndustryTreeMapRequest,
  O: IndustryTreeMap,
  service: {
    typeName: "shorts.v1alpha1.ShortedStocksService"
  }
} as const;

/**
 * Provides an overview of a specific stock based on PRODUCT_CODE.
 *
 * @generated from rpc shorts.v1alpha1.ShortedStocksService.GetStock
 */
export const getStock = {
  localName: "getStock",
  name: "GetStock",
  kind: MethodKind.Unary,
  I: GetStockRequest,
  O: Stock,
  service: {
    typeName: "shorts.v1alpha1.ShortedStocksService"
  }
} as const;

/**
 * Provides a more in-depth breakdown of a particular stock's metadata.
 *
 * @generated from rpc shorts.v1alpha1.ShortedStocksService.GetStockDetails
 */
export const getStockDetails = {
  localName: "getStockDetails",
  name: "GetStockDetails",
  kind: MethodKind.Unary,
  I: GetStockDetailsRequest,
  O: StockDetails,
  service: {
    typeName: "shorts.v1alpha1.ShortedStocksService"
  }
} as const;

/**
 * fetch time series data for a specific stock
 *
 * @generated from rpc shorts.v1alpha1.ShortedStocksService.GetStockData
 */
export const getStockData = {
  localName: "getStockData",
  name: "GetStockData",
  kind: MethodKind.Unary,
  I: GetStockDataRequest,
  O: TimeSeriesData,
  service: {
    typeName: "shorts.v1alpha1.ShortedStocksService"
  }
} as const;
