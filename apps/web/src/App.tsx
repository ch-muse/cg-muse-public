import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./lib/api.js";
import PlayMusePage from "./pages/PlayMuse.js";
import PlayWhisperPage from "./pages/PlayWhisper.js";
import PlayComfyRunnerPage from "./pages/PlayComfyRunner.js";
import LikedIdeasPage from "./pages/LikedIdeas.js";
import SessionsPage from "./pages/Sessions.js";
import SessionDetailPage from "./pages/SessionDetail.js";
import GalleryPage from "./pages/Gallery.js";
import WorkshopLorasList from "./pages/workshop/WorkshopLorasList.js";
import WorkshopLoraForm from "./pages/workshop/WorkshopLoraForm.js";
import WorkshopRecipesList from "./pages/workshop/WorkshopRecipesList.js";
import WorkshopRecipeForm from "./pages/workshop/WorkshopRecipeForm.js";
import ComfyPanel from "./pages/ComfyPanel.js";
import InternalsDictionaryPage from "./pages/internals/InternalsDictionary.js";
import InternalsGallerySourcesPage from "./pages/internals/InternalsGallerySources.js";
import NavGroupList from "./components/NavGroupList.js";

export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            CG Muse
          </Link>
          <nav className="flex items-center gap-3">
            <ComfyIndicator />
          </nav>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl gap-6 px-6 py-8">
        <aside className="hidden w-60 shrink-0 lg:block">
          <NavGroupList />
        </aside>
        <main className="min-w-0 flex-1">
          <Routes>
            <Route path="/" element={<PlayMusePage />} />
            <Route path="/play/muse" element={<PlayMusePage />} />
            <Route path="/play/whisper" element={<PlayWhisperPage />} />
            <Route path="/play/comfy" element={<PlayComfyRunnerPage />} />
            <Route path="/play/liked" element={<LikedIdeasPage />} />
            <Route path="/gallery" element={<GalleryPage />} />
            <Route path="/workshop/loras" element={<WorkshopLorasList />} />
            <Route path="/workshop/loras/new" element={<WorkshopLoraForm />} />
            <Route path="/workshop/loras/:id" element={<WorkshopLoraForm />} />
            <Route path="/workshop/recipes" element={<WorkshopRecipesList />} />
            <Route path="/workshop/recipes/new" element={<WorkshopRecipeForm />} />
            <Route path="/workshop/recipes/:id" element={<WorkshopRecipeForm />} />
            <Route path="/internals/sessions" element={<SessionsPage />} />
            <Route path="/internals/sessions/:id" element={<SessionDetailPage />} />
            <Route path="/internals/dictionary" element={<InternalsDictionaryPage />} />
            <Route path="/internals/tagcomplete" element={<Navigate to="/internals/dictionary" replace />} />
            <Route path="/internals/translations" element={<Navigate to="/internals/dictionary" replace />} />
            <Route path="/internals/gallery-sources" element={<InternalsGallerySourcesPage />} />
            <Route path="/internals/comfy" element={<ComfyPanel />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function ComfyIndicator() {
  const [state, setState] = useState<"unknown" | "running" | "stopped">("unknown");

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const data = await api.getComfyStatus();
        if (!active) return;
        setState(data.status.running ? "running" : "stopped");
      } catch {
        if (active) setState("unknown");
      } finally {
        if (!active) return;
        timer = setTimeout(poll, 8000);
      }
    };

    poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const color =
    state === "running" ? "bg-emerald-400" : state === "stopped" ? "bg-slate-500" : "bg-amber-400";
  const label = state === "running" ? "Running" : state === "stopped" ? "Stopped" : "Checking";

  return (
    <Link
      to="/internals/comfy"
      className="flex items-center gap-2 rounded-md border border-slate-800 px-2 py-1 text-xs text-slate-300 transition hover:border-emerald-400/60 hover:text-white"
    >
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span>ComfyUI {label}</span>
    </Link>
  );
}
