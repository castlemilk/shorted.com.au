import { NextResponse, type NextRequest } from "next/server";
import { auth } from "~/server/auth";
import { getToken } from "next-auth/jwt";
import { cookies } from "next/headers";

export async function GET(request: NextRequest) {
  try {
    // Get server-side session
    const session = await auth();
    
    // Get JWT token
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });

    // Get cookies
    const cookieStore = cookies();
    const allCookies = cookieStore.getAll();
    const sessionTokenCookie = allCookies.find(c => 
      c.name.includes('next-auth.session-token') || 
      c.name.includes('__Secure-next-auth.session-token')
    );

    return NextResponse.json({
      hasSession: !!session,
      session: session ? {
        user: session.user,
        expires: session.expires,
      } : null,
      hasToken: !!token,
      hasSub: !!token?.sub,
      tokenPreview: token ? {
        sub: token.sub,
        email: token.email,
        id: token.id,
        name: token.name,
      } : null,
      cookies: {
        hasSessionToken: !!sessionTokenCookie,
        sessionTokenName: sessionTokenCookie?.name,
        totalCookies: allCookies.length,
        cookieNames: allCookies.map(c => c.name),
      },
      env: {
        hasNextAuthSecret: !!process.env.NEXTAUTH_SECRET,
        nodeEnv: process.env.NODE_ENV,
      }
    });
  } catch (error) {
    console.error("Debug session error:", error);
    return NextResponse.json({
      error: String(error),
      message: "Error fetching session debug info"
    }, { status: 500 });
  }
}

