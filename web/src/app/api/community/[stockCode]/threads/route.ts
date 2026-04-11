import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { listCommunityThreads } from "~/@/lib/community/firestore-community";

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
    const threads = await listCommunityThreads(stockCode);

    return NextResponse.json({
      stockCode,
      threads,
    });
  } catch (error) {
    console.error("Failed to fetch community threads", error);
    return NextResponse.json(
      { error: "Failed to fetch community threads" },
      { status: 500 },
    );
  }
}
