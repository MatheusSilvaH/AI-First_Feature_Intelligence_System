import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { CustomerTier, SubmitterType } from "../api/types";

const SUBMITTER_TYPES: Array<{ value: SubmitterType; label: string; hint: string }> = [
  { value: "customer", label: "Customer", hint: "You pay for the product today" },
  { value: "prospect", label: "Prospect", hint: "You are evaluating the product" },
  { value: "support", label: "Support", hint: "Relaying a problem on someone's behalf" },
  { value: "internal", label: "Internal", hint: "You work here" },
];

const TIERS: CustomerTier[] = ["enterprise", "growth", "starter", "free"];

export function SubmitPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [type, setType] = useState<SubmitterType>("customer");
  const [tier, setTier] = useState<CustomerTier | "">("");
  const [accountName, setAccountName] = useState("");

  const mutation = useMutation({
    mutationFn: api.submitRequest,
    onSuccess: (result) => navigate(`/requests/${result.request.id}?new=1`),
  });

  const showTier = type === "customer" || type === "prospect";

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate({
      title: title.trim(),
      description: description.trim(),
      submitter: {
        name: name.trim(),
        type,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(showTier && tier ? { tier } : {}),
        ...(accountName.trim() ? { accountName: accountName.trim() } : {}),
      },
    });
  };

  const fieldErrors =
    mutation.error instanceof ApiError
      ? Object.fromEntries((mutation.error.details ?? []).map((d) => [d.path, d.message]))
      : {};

  return (
    <>
      <div className="page-header">
        <h1>Submit a request</h1>
        <p>
          Describe the problem you are running into, not just the feature you have in mind. The
          more concretely you describe what it costs you today, the more accurately it can be
          weighed against everything else.
        </p>
      </div>

      <form onSubmit={onSubmit} className="card" noValidate>
        <div className="field">
          <label htmlFor="title">What do you need?</label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Scheduled export of our data"
            maxLength={200}
            required
            aria-describedby="title-hint"
            aria-invalid={Boolean(fieldErrors.title)}
          />
          <div className="hint" id="title-hint">
            A short summary. {fieldErrors.title ? <strong>{fieldErrors.title}</strong> : null}
          </div>
        </div>

        <div className="field">
          <label htmlFor="description">What is the problem behind it?</label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Every Monday someone on my team spends three hours copying records into a spreadsheet for our business review. If it broke, we would miss the meeting."
            maxLength={8000}
            required
            aria-describedby="description-hint"
            aria-invalid={Boolean(fieldErrors.description)}
          />
          <div className="hint" id="description-hint">
            What are you trying to accomplish, what happens today, and what does the workaround
            cost you? {description.length}/8000.{" "}
            {fieldErrors.description ? <strong>{fieldErrors.description}</strong> : null}
          </div>
        </div>

        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              aria-describedby="email-hint"
            />
            <div className="hint" id="email-hint">
              Used to link your requests together and to reach you with a decision.
            </div>
          </div>
        </div>

        <div className="grid grid-3">
          <div className="field">
            <label htmlFor="type">You are a…</label>
            <select
              id="type"
              value={type}
              onChange={(e) => setType(e.target.value as SubmitterType)}
            >
              {SUBMITTER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <div className="hint">
              {SUBMITTER_TYPES.find((t) => t.value === type)?.hint}
            </div>
          </div>

          {showTier ? (
            <div className="field">
              <label htmlFor="tier">Plan</label>
              <select
                id="tier"
                value={tier}
                onChange={(e) => setTier(e.target.value as CustomerTier | "")}
              >
                <option value="">Not sure</option>
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="account">Company</label>
            <input
              id="account"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              maxLength={200}
            />
          </div>
        </div>

        {mutation.isError ? (
          <div className="notice error" role="alert" style={{ marginBottom: "1rem" }}>
            {mutation.error instanceof ApiError
              ? mutation.error.message
              : "Could not submit the request."}
          </div>
        ) : null}

        <div className="row">
          <button type="submit" className="primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Submitting…" : "Submit request"}
          </button>
          <span className="faint">
            Analysed for duplicates and priority automatically — usually within a minute.
          </span>
        </div>
      </form>
    </>
  );
}
