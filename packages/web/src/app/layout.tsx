// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/lib/i18n/context";
import { getServerLocale } from "@/lib/i18n/server";
import { AuthSessionProvider } from "@/components/auth/session-provider";
import { Toaster } from "sonner";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Polyant",
  description:
    "Open-source platform for building AI assistants with long-term memory, multi-channel support, and per-instance customization.",
  applicationName: "Polyant",
  authors: [{ name: "Exelab S.r.l.", url: "https://github.com/polyant-ai/polyant" }],
  keywords: ["ai", "assistant", "llm", "polyant", "agent"],
  metadataBase: new URL("https://github.com/polyant-ai/polyant"),
  openGraph: {
    title: "Polyant",
    description:
      "Open-source platform for building AI assistants with long-term memory, multi-channel support, and per-instance customization.",
    siteName: "Polyant",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Polyant",
    description:
      "Open-source platform for building AI assistants with long-term memory, multi-channel support, and per-instance customization.",
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getServerLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          storageKey="theme"
        >
          <AuthSessionProvider>
            <I18nProvider initialLocale={locale}>
              {children}
              <Toaster position="bottom-right" />
            </I18nProvider>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
