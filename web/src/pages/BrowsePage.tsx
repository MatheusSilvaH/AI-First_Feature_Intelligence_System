import { useState, useMemo, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../api/client";
import type { SubmitterType } from "../api/types";
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  ScorePill,
  SeverityBadge,
  SubmitterBadge,
  relativeTime,
} from "../components/common";

/** Debounce so typing in the search box does not fire a request per keystroke. */
function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function BrowsePage() {
  const [params, setParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(params.get("search") ?? "");
  const search = useDebounced(searchInput);

  const submitterType = (params.get("submitterType") ?? "") as SubmitterType | "";
  const themeId = params.get("themeId") ?? "";
  const page = Number(params.get("page") ?? 1);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current page number.
    if (key !== "page") next.delete("page");
    setParams(next);
  };

  const themesQuery = useQuery({ queryKey: ["themes"], queryFn: api.themes });

  const requestsQuery = useQuery({
    queryKey: ["requests", { search, submitterType, themeId, page }],
    queryFn: () =>
      api.listRequests({
        search: search || undefined,
        submitterType: submitterType || undefined,
        themeId: themeId || undefined,
        page,
        pageSize: 20,
      }),
    // Keeps the previous page on screen while the next one loads, instead of
    // flashing an empty list under the user's cursor.
    placeholderData: keepPreviousData,
  });

  const data = requestsQuery.data;

  const consolidated = useMemo(
    () => data?.items.filter((i) => (i.cluster?.memberCount ?? 1) > 1).length ?? 0,
    [data],
  );

  return (
    <>
      <div className="page-header">
        <h1>Discover requests</h1>
        <p>
          Requests are grouped by the problem underneath them, not by wording. Open any request to
          see what it was grouped with and why.
        </p>
      </div>

      <div className="filters">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setParam("search", e.target.value);
          }}
          placeholder="Search requests…"
          aria-label="Search requests"
        />
        <select
          value={submitterType}
          onChange={(e) => setParam("submitterType", e.target.value)}
          aria-label="Filter by submitter type"
        >
          <option value="">All submitters</option>
          <option value="customer">Customers</option>
          <option value="prospect">Prospects</option>
          <option value="support">Support</option>
          <option value="internal">Internal</option>
        </select>
        <select
          value={themeId}
          onChange={(e) => setParam("themeId", e.target.value)}
          aria-label="Filter by theme"
        >
          <option value="">All themes</option>
          {themesQuery.data?.themes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {requestsQuery.isError ? <ErrorNotice error={requestsQuery.error} /> : null}
      {requestsQuery.isLoading ? <Loading rows={4} /> : null}

      {data ? (
        <>
          <p className="faint" style={{ marginBottom: "0.9rem" }}>
            {data.total} request{data.total === 1 ? "" : "s"}
            {consolidated > 0 ? ` · ${consolidated} on this page share a cluster with others` : ""}
          </p>

          {data.items.length === 0 ? (
            <Empty>
              <p>No requests match those filters.</p>
              <Link to="/submit">Submit the first one</Link>
            </Empty>
          ) : (
            <div className="list">
              {data.items.map((item) => (
                <Link key={item.id} to={`/requests/${item.id}`} className="list-item">
                  <div className="spread">
                    <div style={{ minWidth: 0 }}>
                      <h3>{item.title}</h3>
                      {item.underlyingNeed ? (
                        <p className="small muted" style={{ marginBottom: "0.5rem" }}>
                          <span className="badge ai">✦ need</span> {item.underlyingNeed}
                        </p>
                      ) : (
                        <p className="small faint" style={{ marginBottom: "0.5rem" }}>
                          Awaiting analysis…
                        </p>
                      )}
                      <div className="row">
                        <SubmitterBadge type={item.submitterType} />
                        {item.severity ? <SeverityBadge severity={item.severity} /> : null}
                        {item.cluster && item.cluster.memberCount > 1 ? (
                          <Badge variant="ai">
                            ✦ consolidates {item.cluster.memberCount} requests
                          </Badge>
                        ) : null}
                        {item.cluster && item.cluster.supporterCount > 0 ? (
                          <Badge>
                            {item.cluster.supporterCount} supporter
                            {item.cluster.supporterCount === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                        <span className="faint">{relativeTime(item.createdAt)}</span>
                      </div>
                    </div>
                    <ScorePill score={item.cluster?.score ?? null} />
                  </div>
                </Link>
              ))}
            </div>
          )}

          {data.totalPages > 1 ? (
            <nav className="pagination" aria-label="Pagination">
              <button
                onClick={() => setParam("page", String(page - 1))}
                disabled={page <= 1}
                type="button"
              >
                Previous
              </button>
              <span className="faint">
                Page {data.page} of {data.totalPages}
              </span>
              <button
                onClick={() => setParam("page", String(page + 1))}
                disabled={page >= data.totalPages}
                type="button"
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
    </>
  );
}
