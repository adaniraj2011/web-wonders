export const metadata = {
  title: "Web Wonders · Studio OS",
  description: "All-in-one studio dashboard for Web Wonders digital marketing."
};

import "./globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
