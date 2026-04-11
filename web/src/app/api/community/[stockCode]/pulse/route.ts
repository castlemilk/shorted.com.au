import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { listCommunityPulseItems } from "~/@/lib/community/firestore-community";

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
    const pulse = await listCommunityPulseItems(stockCode);

    return NextResponse.json({
      stockCode,
      pulse,
    });
  } catch (error) {
    console.error("Failed to fetch community pulse", error);
    return NextResponse.json(
      { error: "Failed to fetch community pulse" },
      { status: 500 },
    );
  }
}
