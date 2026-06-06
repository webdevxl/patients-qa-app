import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";

// CareBrain brand fonts. Plus Jakarta Sans (body + heading) and Geist Mono (for
// trace IDs / ICD codes / citation chips). Exposed as the same CSS variables that
// globals.css consumes: `--font-sans` and `--font-geist-mono`.
const sans = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CareBrain Admin · Observability",
  description: "Audit log viewer for the Patient Q&A assistant",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
