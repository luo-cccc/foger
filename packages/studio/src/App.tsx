import { lazy, Suspense, useState, useEffect } from "react";
import { useHashRoute } from "./hooks/use-hash-route";
import type { HashRoute } from "./hooks/use-hash-route";
import { Sidebar } from "./components/Sidebar";
import { useSSE } from "./hooks/use-sse";
import { useSessionEvents } from "./hooks/use-session-events";
import { useTheme } from "./hooks/use-theme";
import { useI18n } from "./hooks/use-i18n";
import { setAppLanguage } from "./lib/app-language";
import { postApi, putApi, useApi } from "./hooks/use-api";
import { Sun, Moon } from "lucide-react";
import { House } from "lucide-react";

export type { HashRoute as Route } from "./hooks/use-hash-route";

const Dashboard = lazy(() => import("./pages/Dashboard").then((mod) => ({ default: mod.Dashboard })));
const ChatPage = lazy(() => import("./pages/ChatPage").then((mod) => ({ default: mod.ChatPage })));
const BookDetail = lazy(() => import("./pages/BookDetail").then((mod) => ({ default: mod.BookDetail })));
const ChapterReader = lazy(() => import("./pages/ChapterReader").then((mod) => ({ default: mod.ChapterReader })));
const Analytics = lazy(() => import("./pages/Analytics").then((mod) => ({ default: mod.Analytics })));
const ServiceListPage = lazy(() => import("./pages/ServiceListPage").then((mod) => ({ default: mod.ServiceListPage })));
const ServiceDetailPage = lazy(() => import("./pages/ServiceDetailPage").then((mod) => ({ default: mod.ServiceDetailPage })));
const ProjectSettings = lazy(() => import("./pages/ProjectSettings").then((mod) => ({ default: mod.ProjectSettings })));
const TruthFiles = lazy(() => import("./pages/TruthFiles").then((mod) => ({ default: mod.TruthFiles })));
const DaemonControl = lazy(() => import("./pages/DaemonControl").then((mod) => ({ default: mod.DaemonControl })));
const LogViewer = lazy(() => import("./pages/LogViewer").then((mod) => ({ default: mod.LogViewer })));
const GenreManager = lazy(() => import("./pages/GenreManager").then((mod) => ({ default: mod.GenreManager })));
const ImportManager = lazy(() => import("./pages/ImportManager").then((mod) => ({ default: mod.ImportManager })));
const DoctorView = lazy(() => import("./pages/DoctorView").then((mod) => ({ default: mod.DoctorView })));
const LanguageSelector = lazy(() => import("./pages/LanguageSelector").then((mod) => ({ default: mod.LanguageSelector })));
const BookSidebar = lazy(() => import("./components/chat/BookSidebar").then((mod) => ({ default: mod.BookSidebar })));
const BookSidebarToggle = lazy(() => import("./components/chat/BookSidebar").then((mod) => ({ default: mod.BookSidebarToggle })));

export function deriveActiveBookId(route: HashRoute): string | undefined {
  if ("bookId" in route) return route.bookId;
  return undefined;
}

export function isBookCreateChatRoute(route: HashRoute): boolean {
  return route.page === "book-create";
}

export function deriveStartupGate(input: {
  readonly ready: boolean;
  readonly projectError: string | null;
}): "ready" | "loading" | "error" {
  if (input.ready) return "ready";
  return input.projectError ? "error" : "loading";
}

function RouteLoading() {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center">
      <div className="h-8 w-8 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
    </div>
  );
}

export function App() {
  const { route, setRoute } = useHashRoute();
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const { t, lang: currentLang } = useI18n();
  const { data: project, error: projectError, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);

  const isDark = theme === "dark";

  // 全局语言同步：app-language 是模块级单例，供用不了 hook 的代码（lib 纯函数、
  // store slice）读取。这里在渲染期同步赋值，让子组件在同一次渲染里调用 tr() 时
  // 就读到正确语言（只用 effect 的话，effect 要等本次渲染提交后才执行，本次渲染
  // 里的 tr() 会读到旧语言）。赋值是幂等的模块变量写入，StrictMode 重复渲染无影
  // 响；下面的 effect 在语言加载完成和切换时再设置一次，保证提交后的值也正确。
  setAppLanguage(currentLang);
  useEffect(() => {
    setAppLanguage(currentLang);
  }, [currentLang]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    if (project) {
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      setReady(true);
    }
  }, [project]);

  useSessionEvents(sse, route, setRoute);

  const nav = {
    toDashboard: () => setRoute({ page: "dashboard" }),
    toChat: () => setRoute({ page: "chat" }),
    toBook: (bookId: string) => setRoute({ page: "book", bookId }),
    toBookSettings: (bookId: string) => setRoute({ page: "book-settings", bookId }),
    toBookCreate: () => setRoute({ page: "book-create" }),
    toChapter: (bookId: string, chapterNumber: number) =>
      setRoute({ page: "chapter", bookId, chapterNumber }),
    toAnalytics: (bookId: string) => setRoute({ page: "analytics", bookId }),
    toServices: () => setRoute({ page: "services" }),
    toProjectSettings: () => setRoute({ page: "project-settings" }),
    toServiceDetail: (id: string) => setRoute({ page: "service-detail", serviceId: id }),
    toTruth: (bookId: string) => setRoute({ page: "truth", bookId }),
    toDaemon: () => setRoute({ page: "daemon" }),
    toLogs: () => setRoute({ page: "logs" }),
    toGenres: () => setRoute({ page: "genres" }),
    toImport: (tab?: "chapters" | "canon") => setRoute({ page: "import", ...(tab ? { tab } : {}) }),
    toDoctor: (operationId?: string) => setRoute({ page: "doctor", ...(operationId ? { operationId } : {}) }),
  };

  const activeBookId = deriveActiveBookId(route);
  const activePage =
    activeBookId
      ? `book:${activeBookId}`
      : route.page === "service-detail"
        ? "services"
        : route.page;

  const startupGate = deriveStartupGate({ ready, projectError });

  if (startupGate === "error") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-destructive/30 bg-destructive/5 p-6 space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-destructive">无法加载项目配置 / Failed to load project config</h1>
            <p className="mt-2 text-sm text-muted-foreground break-all">{projectError}</p>
          </div>
          {/* 项目配置没加载出来，语言未知，所以这屏中英双语并排展示。 */}
          <p className="text-sm text-muted-foreground">
            请检查项目根目录下的 inkos.json 是否存在且为合法 JSON，然后重试。
            <br />
            Check that inkos.json in the project root exists and is valid JSON, then retry.
          </p>
          <button
            type="button"
            onClick={() => refetchProject()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            重试 / Retry
          </button>
        </div>
      </div>
    );
  }

  if (startupGate === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <Suspense fallback={<RouteLoading />}>
        <LanguageSelector
          onSelect={async (lang) => {
            await postApi("/project/language", { language: lang });
            setShowLanguageSelector(false);
            refetchProject();
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="h-screen bg-background text-foreground flex overflow-hidden font-sans">
      {/* Left Sidebar */}
      <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} />

      {/* Center Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-background/30 backdrop-blur-sm">
        {/* Header Strip */}
        <header className="h-14 shrink-0 flex items-center justify-between px-8 border-b border-border/40">
          <div className="flex items-center gap-2">
             <button
               onClick={nav.toDashboard}
               className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-card/70 px-3.5 py-2 text-[17px] font-semibold text-foreground hover:bg-secondary/50 transition-colors"
             >
               <House size={18} />
               <span>{t("bread.home")}</span>
               <span className="text-muted-foreground/70">/</span>
               <span className="font-serif">InkOS Studio</span>
             </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex gap-0.5 bg-muted/50 rounded-lg p-0.5">
              <button
                onClick={async () => {
                  await putApi("/project", { language: "zh" });
                  refetchProject();
                }}
                className={`px-2.5 py-1 text-[16px] font-medium rounded-md ${currentLang === "zh" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                中
              </button>
              <button
                onClick={async () => {
                  await putApi("/project", { language: "en" });
                  refetchProject();
                }}
                className={`px-2.5 py-1 text-[16px] font-medium rounded-md ${currentLang === "en" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                EN
              </button>
            </div>

            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {isDark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 relative overflow-y-auto scroll-smooth">
          <Suspense fallback={<RouteLoading />}>
            {route.page === "dashboard" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <Dashboard nav={nav} sse={sse} theme={theme} t={t} />
              </div>
            )}
            {isBookCreateChatRoute(route) && (
              <div className="absolute inset-0 flex min-w-0">
                <ChatPage
                  mode="book-create"
                  nav={nav}
                  theme={theme}
                  t={t}
                  sse={sse}
                />
              </div>
            )}
            {route.page === "chat" && (
              <div className="absolute inset-0 flex min-w-0">
                <ChatPage
                  mode="project-chat"
                  nav={nav}
                  theme={theme}
                  t={t}
                  sse={sse}
                />
              </div>
            )}
            {route.page === "book" && (
              <div className="absolute inset-0 flex min-w-0">
                <ChatPage
                  activeBookId={route.bookId}
                  mode="book"
                  nav={nav}
                  theme={theme}
                  t={t}
                  sse={sse}
                />
                <BookSidebar bookId={route.bookId} theme={theme} t={t} sse={sse} />
                <BookSidebarToggle bookId={route.bookId} theme={theme} t={t} sse={sse} />
              </div>
            )}
            {route.page === "book-settings" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <BookDetail bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />
              </div>
            )}
            {route.page === "chapter" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <ChapterReader bookId={route.bookId} chapterNumber={route.chapterNumber} nav={nav} theme={theme} t={t} />
              </div>
            )}
            {route.page === "analytics" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <Analytics bookId={route.bookId} nav={nav} theme={theme} t={t} />
              </div>
            )}
            {route.page === "services" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <ServiceListPage nav={nav} />
              </div>
            )}
            {route.page === "project-settings" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <ProjectSettings nav={nav} theme={theme} t={t} />
              </div>
            )}
            {route.page === "service-detail" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <ServiceDetailPage serviceId={route.serviceId} nav={nav} />
              </div>
            )}
            {route.page === "truth" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <TruthFiles bookId={route.bookId} nav={nav} theme={theme} t={t} />
              </div>
            )}
            {route.page === "daemon" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <DaemonControl nav={nav} theme={theme} t={t} sse={sse} />
              </div>
            )}
            {route.page === "logs" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <LogViewer nav={nav} theme={theme} t={t} />
              </div>
            )}
            {route.page === "genres" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <GenreManager nav={nav} theme={theme} t={t} />
              </div>
            )}
            {route.page === "import" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <ImportManager nav={nav} theme={theme} t={t} initialTab={route.tab} />
              </div>
            )}
            {route.page === "doctor" && (
              <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
                <DoctorView nav={nav} operationId={route.operationId} theme={theme} t={t} sse={sse} />
              </div>
            )}
          </Suspense>
        </main>
      </div>
    </div>
  );
}
