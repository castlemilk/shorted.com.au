'use client'

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'
import { Button } from '~/@/components/ui/button'
import { RateLimitNotice } from '~/@/components/rate-limit/rate-limit-notice'
import { isRateLimitError, parseRateLimitInfo } from '~/@/lib/retry'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log error for debugging
    console.error('Error boundary caught:', error)
    if (error?.stack) {
      console.error('Error stack:', error.stack)
    }
    if (error?.digest) {
      console.error('Error digest:', error.digest)
    }
  }, [error])

  // A rate limit that escaped all the way to the page boundary. We still do
  // NOT redirect anywhere — the user stays on their URL and gets the panel in
  // place, so a retry (or the automatic per-minute recovery) puts them back
  // exactly where they were.
  if (isRateLimitError(error)) {
    const rateLimitInfo = parseRateLimitInfo(error)
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-8">
        <RateLimitNotice
          info={rateLimitInfo}
          variant="page"
          onRetry={reset}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-6 flex justify-center">
          <div className="rounded-full bg-destructive/10 p-4">
            <AlertTriangle className="h-12 w-12 text-destructive" />
          </div>
        </div>

        <h2 className="mb-2 text-2xl font-bold">Something went wrong</h2>
        <p className="mb-6 text-muted-foreground">
          We encountered an unexpected error. Please try again or return to the home page.
        </p>

        {/* Show error details in development */}
        {process.env.NODE_ENV === 'development' && error?.message && (
          <details className="mb-6 text-left">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
              Error details
            </summary>
            <pre className="mt-2 overflow-auto rounded-lg bg-muted p-4 text-xs">
              {error.message}
              {error.stack && (
                <>
                  {'\n\n'}
                  {error.stack}
                </>
              )}
            </pre>
          </details>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button onClick={reset} variant="default">
            <RefreshCw className="mr-2 h-4 w-4" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <a href="/">
              <Home className="mr-2 h-4 w-4" />
              Go home
            </a>
          </Button>
        </div>

        {error?.digest && (
          <p className="mt-6 text-xs text-muted-foreground">
            Error ID: {error.digest}
          </p>
        )}
      </div>
    </div>
  )
}
