import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Mona_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Providers } from "@/lib/providers";
import "./globals.css";

const mona = Mona_Sans({
  subsets: ["latin", "latin-ext"],
  axes: ["wdth"],
  variable: "--font-mona",
  display: "swap",
});

// One accent phrase per headline, in italic (docs/BRAND.md → Type).
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument", display: "swap" });

export const metadata: Metadata = {
  title: "Nudge: let your AI pay, only within your rules",
  description: "Claude and your other assistants pay your saved contacts within limits you set. Anything bigger waits for your passkey, and a contract enforces it even if a key is stolen.",
  applicationName: "Nudge",
  appleWebApp: { capable: true, title: "Nudge", statusBarStyle: "default" },
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
      <html lang="en" className={`${mona.variable} ${serif.variable}`}>
        <body>
          <Providers>{children}</Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
