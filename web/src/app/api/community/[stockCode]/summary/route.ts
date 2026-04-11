import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getStockCommunitySummary } from "~/@/lib/community/firestore-community";

const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,4}$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ stockCode: string }> },
) {
  const { stockCode: rawStockCode } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode)) {
    return NextResponse.json({ error: "Invalid stock code" }, { status: 400 });
  }

  try {
    const summary = await getStockCommunitySummary(stockCode);

    return NextResponse.json({
      stockCode,
      summary,
    });
  } catch (error) {
    console.error("Failed to fetch community summary", error);
    return NextResponse.json(
      { error: "Failed to fetch community summary" },
      { status: 500 },
    );
  }
}
