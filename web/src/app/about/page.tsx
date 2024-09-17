import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Eye, TrendingDown, BarChart2, Bell } from "lucide-react"

const Page = () => {
  return (
    <div className="flex flex-col min-h-screen bg-gray-50 dark:bg-gray-900">
      <main className="flex-1">
        <section className="w-full py-12 md:py-24 lg:py-32 xl:py-48">
          <div className="container px-4 md:px-6">
            <div className="flex flex-col items-center space-y-4 text-center">
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl lg:text-6xl/none">
                Get faster
                </h1>
                <h1 className="text-3xl font-bold tracking-tighter text-blue-500 sm:text-4xl md:text-5xl lg:text-6xl/none">
                Insights on Sentiment
                </h1>
                <p className="mx-auto max-w-[700px] md:text-xl leading-6">
                  Welcome to Shorted. Our goal is to provide a simple and intuitive interface for monitoring
                  short positions on the ASX, with enhanced features for getting insights sooner
                </p>
              </div>
            </div>
          </div>
        </section>
        <section className="w-full py-4 md:py-12 lg:py-12 bg-white dark:bg-gray-800">
          <div className="container px-4 md:px-6">
            <h2 className="text-2xl font-bold tracking-tighter sm:text-3xl md:text-4xl text-center mb-8">
             Features 
            </h2>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader>
                  <Eye className="h-6 w-6 mb-2" />
                  <CardTitle>View Current Positions</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Easily monitor your active short positions in real-time.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <TrendingDown className="h-6 w-6 mb-2" />
                  <CardTitle>Track Performance</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Analyze the performance of your short positions over time.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <BarChart2 className="h-6 w-6 mb-2" />
                  <CardTitle>Analyze Trends</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Stay informed with up-to-date market trend analysis.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <Bell className="h-6 w-6 mb-2" />
                  <CardTitle>Notifications</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Receive alerts on significant market changes affecting your positions.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>
        <section className="w-full py-12 md:py-24 lg:py-32">
          <div className="container px-4 md:px-6">
            <div className="flex flex-col items-center space-y-4 text-center">
              <div className="space-y-2">
                <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
                  Ready to Discover interesting open Short Positions?
                </h2>
                <p className="mx-auto max-w-[600px] text-gray-500 md:text-xl dark:text-gray-400">
                  We hope you find this tool useful for managing your short position investments.
                </p>
              </div>
              <div className="w-full max-w-sm space-y-2">
                <Link href="/">
                  <Button className="w-full">Get Started</Button>
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default Page;