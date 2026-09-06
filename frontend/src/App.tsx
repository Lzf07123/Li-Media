import { Navigate, Route, Routes, useParams } from "react-router-dom";

import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import AdminPage from "@/pages/AdminPage";
import BaiduCallbackPage from "@/pages/BaiduCallbackPage";
import HomePage from "@/pages/HomePage";
import NotFoundPage from "@/pages/NotFoundPage";
import BackToTop from "@/components/BackToTop";

function MemoryRedirect() {
  const { memoryId } = useParams();
  return <Navigate replace to={`/?viewer=${memoryId}`} />;
}

export default function App() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <SiteHeader />

      <main className="page-shell mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 lg:px-8" id="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/memories/:memoryId" element={<MemoryRedirect />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/baidu/callback" element={<BaiduCallbackPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>

      <SiteFooter />
      <BackToTop />
    </div>
  );
}
