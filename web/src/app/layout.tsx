import "~/styles/globals.css";

import { Inter as FontSans } from "next/font/google"


import { cn } from "../@/lib/utils"
import { NextAuthProvider } from "./next-auth-provider";
import { createConnectTransport } from "@connectrpc/connect-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransportProvider } from "@connectrpc/connect-query";

const fontSans = FontSans({
  subsets: ["latin"],
  variable: "--font-sans",
})

export const metadata = {
  title: "Shorted",
  description: "Check whos caught with their pants down",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};


export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={cn(
          "min-h-screen bg-background font-sans antialiased",
          fontSans.variable
        )}>
          {/* <NextAuthProvider> */}
            {/* <TransportProvider transport={finalTransport}> */}
              {/* <QueryClientProvider client={queryClient}> */}
                {children}
              {/* </QueryClientProvider> */}
            {/* </TransportProvider> */}
          {/* </NextAuthProvider> */}
      </body>
    </html>
  );
}
