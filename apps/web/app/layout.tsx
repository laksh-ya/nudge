import type { Metadata, Viewport } from "next";
import { Mona_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Providers } from "@/lib/providers";
import "./globals.css";

const mona = Mona_Sans({
  subsets: ["latin", "latin-ext"],
  axes: ["wdth"],
  variable: "--font-mona",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Agent Wallet",
  description: "Your money, your assistant, and exactly what it's allowed to spend.",
  applicationName: "Agent Wallet",
  appleWebApp: { capable: true, title: "Agent Wallet", statusBarStyle: "default" },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#002970",
          colorForeground: "#101010",
          colorMutedForeground: "#7e7e7e",
          colorBackground: "#ffffff",
          colorInput: "#ffffff",
          colorBorder: "#e8edf2",
          colorDanger: "#eb5757",
          borderRadius: "10px",
          fontFamily: "var(--font-mona)",
          fontSize: "14px",
        },
      }}
    >
      <html lang="en" className={mona.variable}>
        <body>
          <Providers>{children}</Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
