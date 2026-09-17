import { Suspense, lazy } from "react";
import { NavLink, Route, Routes, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
import { Loading } from "./components/common";
import { BrowsePage } from "./pages/BrowsePage";
import { SubmitPage } from "./pages/SubmitPage";
import { RequestDetailPage } from "./pages/RequestDetailPage";
import { ReviewPage } from "./pages/ReviewPage";

/**
 * The dashboard is the only route that needs Recharts (~400KB). Lazy-loading it
 * keeps that weight off the submit and browse paths, which is where most
 * visitors land.
 */
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);

function QueueIndicator() {
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    // The queue drains in the background; a slow poll keeps the badge honest
    // without hammering the endpoint.
    refetchInterval: 15_000,
  });

  if (!data) return null;

  return (
    <>
      {data.aiMode === "dry-run" ? (
        <span className="badge" title="No Claude calls are being made; stub values are shown.">
          dry-run
        </span>
      ) : null}
      {data.queueDepth > 0 ? (
        <span className="badge ai">✦ analysing {data.queueDepth}</span>
      ) : null}
    </>
  );
}

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Feature <span>Intelligence</span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end>
            Discover
          </NavLink>
          <NavLink to="/submit">Submit</NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/review">Review queue</NavLink>
        </nav>
        <div className="topbar-right">
          <QueueIndicator />
        </div>
      </header>

      <main className="main">
        <Routes>
          <Route path="/" element={<BrowsePage />} />
          <Route path="/submit" element={<SubmitPage />} />
          <Route path="/requests/:id" element={<RequestDetailPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route
            path="/dashboard"
            element={
              <Suspense fallback={<Loading rows={4} />}>
                <DashboardPage />
              </Suspense>
            }
          />
          <Route
            path="*"
            element={
              <div className="empty">
                <p>That page does not exist.</p>
                <Link to="/">Back to discovery</Link>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
