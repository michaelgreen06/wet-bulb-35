import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import Footer from '../components/Footer'
import GoogleAnalytics from '../components/GoogleAnalytics'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Current Wet Bulb Temperature',
  description: 'Calculate and monitor wet bulb temperatures for any location',
  icons: {
    icon: [
      {
        url: '/favicon.svg',
        type: 'image/svg+xml',
      }
    ]
  }
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <GoogleAnalytics />
        <main className="min-h-screen bg-gray-50 py-8 px-4">
          {children}
          <Footer />
        </main>
      </body>
    </html>
  )
}
