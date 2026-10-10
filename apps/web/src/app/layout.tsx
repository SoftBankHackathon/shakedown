import type { Metadata } from "next";
import { LangProvider } from "@/components/i18n";
import { SkipLink, TopBar } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shakedown Deploy",
  description: "One Action, Infinity Clouds. Deploy to your PC and the clouds, then let AI use the app on all of them.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <LangProvider>
          <div className="app-frame">
            <SkipLink />
            <TopBar />
            <main id="main" className="content">{children}</main>
          </div>
        </LangProvider>
      </body>
    </html>
  );
}
