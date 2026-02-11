import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  const tag = request.nextUrl.searchParams.get("tag");

  // Validate secret
  const expectedSecret = process.env.REVALIDATION_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  if (!tag) {
    return NextResponse.json({ error: "Missing tag parameter" }, { status: 400 });
  }

  revalidateTag(tag);
  return NextResponse.json({ revalidated: true, tag, timestamp: Date.now() });
}
