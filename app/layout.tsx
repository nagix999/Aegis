import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aegis 관리 콘솔",
  description: "모델 서버, 요청 검사, 응답 검사, 검증 데이터와 외부 API 배포를 관리합니다.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
