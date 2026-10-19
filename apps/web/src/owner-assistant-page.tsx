import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  Bot,
  BookOpen,
  RotateCcw,
  Send,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { ApiError, api } from "./api";
import "./owner-assistant-page.css";

const models = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash 0731 (default)" },
  { id: "qwen3.6-flash", label: "Qwen 3.6 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
] as const;

type ModelId = (typeof models)[number]["id"];
type Turn = { role: "user" | "assistant"; content: string };
type Source = { title: string; document: string; citation: string };
type AssistantResponse = {
  answer: string;
  model: ModelId;
  sources: Source[];
};
type DisplayMessage = Turn & { sources?: Source[] };

const suggestions = [
  "How do I receive stock from a supplier?",
  "How do I make a backup and restore it?",
  "Why is checkout blocked?",
  "What can a cashier access?",
];

function assistantErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The assistant could not connect. Check the local server and try again.";
  if (error.code === "mixroute_api_key_not_configured")
    return "The assistant is not configured yet. Add MIXROUTE_API_KEY to the server's local .env file and restart Medtryx.";
  if (error.code === "owner_assistant_timeout")
    return "The model took too long to respond. Please try again.";
  if (
    error.code === "mixroute_unavailable" ||
    error.code === "mixroute_request_failed"
  )
    return "MixRoute could not complete the request. Check the internet connection and MixRoute account, then try again.";
  return "The assistant could not answer that. Please try again or ask a developer to verify the guide.";
}

export function OwnerAssistantPage() {
  const [model, setModel] = useState<ModelId>("deepseek-v4-flash");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function sendQuestion(content: string) {
    const prompt = content.trim();
    if (!prompt || sending) return;

    const nextMessages = [
      ...messages,
      { role: "user" as const, content: prompt },
    ];
    const requestMessages = nextMessages.slice(-4);
    setMessages(nextMessages);
    setQuestion("");
    setError("");
    setSending(true);
    try {
      const response = await api.post<AssistantResponse>(
        "/owner-assistant/chat",
        {
          model,
          messages: requestMessages.map(({ role, content: text }) => ({
            role,
            content: text,
          })),
        },
      );
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: response.answer,
          sources: response.sources,
        },
      ]);
    } catch (requestError) {
      setError(assistantErrorMessage(requestError));
    } finally {
      setSending(false);
    }
  }

  async function submitQuestion(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    await sendQuestion(question);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitQuestion();
    }
  }

  function clearConversation() {
    if (sending) return;
    setMessages([]);
    setError("");
  }

  return (
    <section className="page-section owner-assistant-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> OWNER SUPPORT
          </div>
          <h1>Medtryx help</h1>
          <p>
            Ask how the current system works. The assistant can explain
            workflows, but cannot change anything.
          </p>
        </div>
        <label className="assistant-model-picker">
          <span>MODEL</span>
          <select
            aria-label="Assistant model"
            value={model}
            disabled={sending}
            onChange={(event) => setModel(event.target.value as ModelId)}
          >
            {models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="assistant-privacy-note" role="note">
        <ShieldCheck size={17} />
        <span>
          Your question and relevant owner guide sections are sent to MixRoute.
          Do not enter customer identifiers, passwords, API keys, or other
          secrets.
        </span>
      </div>

      <div className="assistant-chat-card">
        <div className="assistant-chat-header">
          <div className="assistant-avatar">
            <Bot size={19} />
          </div>
          <div>
            <strong>Medtryx owner assistant</strong>
            <span>Answers from the owner guide</span>
          </div>
          <button
            className="assistant-clear-button"
            type="button"
            onClick={clearConversation}
            disabled={sending || messages.length === 0}
          >
            <RotateCcw size={15} /> Clear chat
          </button>
        </div>

        <div
          className="assistant-messages"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {messages.length === 0 ? (
            <div className="assistant-welcome">
              <div className="assistant-welcome-icon">
                <BookOpen size={23} />
              </div>
              <h2>What would you like to know?</h2>
              <p>
                I can explain owner workflows and current system limits using
                the Medtryx owner guide.
              </p>
              <div className="assistant-suggestions">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={sending}
                    onClick={() => void sendQuestion(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message, index) => (
              <article
                className={`assistant-message assistant-message-${message.role}`}
                key={`${message.role}-${index}`}
              >
                <div className="assistant-message-icon">
                  {message.role === "assistant" ? (
                    <Bot size={16} />
                  ) : (
                    <UserRound size={16} />
                  )}
                </div>
                <div className="assistant-message-body">
                  <span className="assistant-message-label">
                    {message.role === "assistant" ? "MEDTRYX ASSISTANT" : "YOU"}
                  </span>
                  <p>{message.content}</p>
                  {message.sources && message.sources.length > 0 && (
                    <div className="assistant-sources">
                      <span>GUIDE SECTIONS</span>
                      {message.sources.map((source) => (
                        <span
                          className="assistant-source-chip"
                          key={`${index}-${source.citation}`}
                        >
                          {source.citation} {source.title}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            ))
          )}
          {sending && (
            <div className="assistant-thinking" role="status">
              <span className="assistant-thinking-dots">
                <i />
                <i />
                <i />
              </span>
              Checking the owner guide…
            </div>
          )}
          {error && (
            <div className="assistant-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <form
          className="assistant-composer"
          onSubmit={(event) => void submitQuestion(event)}
        >
          <textarea
            aria-label="Ask a question about Medtryx"
            placeholder="Ask about products, stock, checkout, reports, backups…"
            rows={2}
            maxLength={2000}
            value={question}
            disabled={sending}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="assistant-composer-footer">
            <span>Enter to send · Shift + Enter for a new line</span>
            <button
              className="assistant-send-button"
              type="submit"
              disabled={sending || !question.trim()}
            >
              <Send size={15} /> Ask
            </button>
          </div>
        </form>
      </div>

      <p className="assistant-local-chat-note">
        This conversation stays in this page and is cleared when you leave or
        select Clear chat.
      </p>
    </section>
  );
}
