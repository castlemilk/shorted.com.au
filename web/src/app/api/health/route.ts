import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Basic health check - return 200 if the service is running
    return NextResponse.json(
      { 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'shorted-web'
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { 
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
        service: 'shorted-web'
      },
      { status: 503 }
    );
  }
}