import { Route, Routes } from "react-router-dom";

import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import AdminPage from "@/pages/AdminPage";
import HomePage from "@/pages/HomePage";
import MemoryDetailPage from "@/pages/MemoryDetailPage";
import NotFoundPage from "@/pages/NotFoundPage";

export default function App() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <SiteHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/memories/:memoryId" element={<MemoryDetailPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>

      <SiteFooter />
    </div>
  );
}
