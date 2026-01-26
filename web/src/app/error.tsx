'use client'
 
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  console.error('Error boundary caught:', error)
  console.error('Error stack:', error?.stack)
  console.error('Error digest:', error?.digest)
  
  const errorMessage = error?.message ?? 'An unknown error occurred'
  const errorStack = error?.stack ?? 'No stack trace available'
  
  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold mb-4">Something went wrong!</h2>
      <pre className="bg-gray-100 p-4 rounded overflow-auto">
        {errorMessage}
      </pre>
      <pre className="bg-gray-100 p-4 rounded overflow-auto mt-4 text-xs">
        {errorStack}
      </pre>
      <button
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
        onClick={() => reset()}
      >
        Try again
      </button>
    </div>
  )
}



