
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export async function middleware(_request: NextRequest) {
  // For now, just pass through all requests
  // Authentication will be handled at the page level
  return NextResponse.next()
}

export const config = { matcher: ["/admin/:path*"] }