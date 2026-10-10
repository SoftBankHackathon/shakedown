import type { Metadata } from "next";
import { LangProvider } from "@/components/i18n";
import { TopBar } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shakedown Deploy",
  description: "Deploy to your PC and the cloud, then let AI use the app on both.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <LangProvider>
          <div className="app-frame">
            <a className="skip-link" href="#main">본문으로 이동</a>
            <TopBar />
            <main id="main" className="content">{children}</main>
          </div>
        </LangProvider>
      </body>
    </html>
  );
}
