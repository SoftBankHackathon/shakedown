import type { Metadata } from "next";
import Link from "next/link";
import { LangProvider, LangSwitcher, Tagline } from "@/components/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shakedown Deploy",
  description: "Deploy to your PC and the cloud, then let AI use the app on both.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="antialiased">
        <LangProvider>
          <header className="border-b border-line bg-panel/80 backdrop-blur sticky top-0 z-10">
            <div className="mx-auto max-w-6xl px-5 h-14 flex items-center gap-3">
              <Link href="/" className="font-semibold tracking-tight flex items-center gap-2">
                <span className="inline-block size-2.5 rounded-full bg-ai" />
                Shakedown Deploy
              </Link>
              <Tagline />
              <div className="ml-auto flex items-center gap-4">
                <Link href="/settings" className="text-sm text-muted hover:text-text">API 설정</Link>
                <LangSwitcher />
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
        </LangProvider>
      </body>
    </html>
  );
}
