import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Кино хадмал орчуулагч",
  description: "Англи хадмалыг монгол хэл рүү орчуулах",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="mn">
      <body>{children}</body>
    </html>
  );
}
