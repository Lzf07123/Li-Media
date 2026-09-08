import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";

import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import BaiduCallbackPage from "@/pages/BaiduCallbackPage";
import HomePage from "@/pages/HomePage";
import NotFoundPage from "@/pages/NotFoundPage";
import BackToTop from "@/components/BackToTop";
import AmbientBackground from "@/components/ui/AmbientBackground";

function MemoryRedirect() {
  const { memoryId } = useParams();
  return <Navigate replace to={`/?viewer=${memoryId}`} />;
}

const AdminPage = lazy(() => import("@/pages/AdminPage"));

export default function App() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <AmbientBackground />
      <SiteHeader />

      <main className="page-shell relative z-10 mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 lg:px-8" id="main">
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/memories/:memoryId" element={<MemoryRedirect />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/baidu/callback" element={<BaiduCallbackPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </main>

      <SiteFooter />
      <BackToTop />
    </div>
  );
}
