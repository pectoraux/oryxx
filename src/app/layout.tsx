import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/auth/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ORYXX — Transportation Operating System & Market",
  description:
    "ORYXX moves anything from A to B optimally: a transportation operating system that parses intent into structured events, solves multi-hop routes deterministically across every mode and market, ranks the best feasible plans with honest confidence, and continuously re-optimizes.",
  keywords: [
    "ORYXX",
    "transportation",
    "routing",
    "multi-modal",
    "marketplace",
    "optimization",
    "logistics",
    "mobility",
    "Next.js",
  ],
  authors: [{ name: "ORYXX" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "ORYXX — Transportation Operating System & Market",
    description:
      "Move anything from A to B optimally across every mode and market.",
    url: "https://oryxx.app",
    siteName: "ORYXX",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ORYXX — Transportation Operating System",
    description:
      "Move anything from A to B optimally across every mode and market.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
