"use client";
import { PlainMessage } from "@bufbuild/protobuf";
import { FC } from "react";
import { GetTopShortsResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

export const Top10Chart: FC<{ data: PlainMessage<TimeSeriesData>[] }> = ({ data }) => {
    console.log(data)
    return data ? (
        <div>
            <h1>Top 10</h1>
            <ul>
                {data.map((stock: PlainMessage<TimeSeriesData>) => (
                    <li key={stock.productCode}>{stock.productCode}</li>
                ))}
            </ul>
        </div>
    ) : (
        <div>loading...</div>
    );
};
