import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  type ArtifactView,
  type ApprovalView,
  type UploadView,
  type SkillView,
  type ChatStreamEvent,
} from "./api";
import type {
  AttachmentView,
  JobKind,
  JobView,
  ConversationView,
  MessageView,
  ModelMode,
  Voice,
} from "../shared/contracts";
import "./styles.css";
import "./chat.css";

const kinds: { id: JobKind; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Streaming conversation" },
  { id: "research", label: "Research", hint: "Current, cited report" },
  { id: "analysis", label: "Analyze", hint: "Python on your files" },
  { id: "presentation", label: "Slides", hint: "Validated PowerPoint" },
  { id: "document", label: "Document", hint: "Finished Word report" },
  { id: "website", label: "Website", hint: "Multi-page site ZIP" },
];
const modes: { id: ModelMode; label: string; detail: string }[] = [
  { id: "quick", label: "Quick", detail: "Luna · low" },
  { id: "balanced", label: "Balanced", detail: "Terra · medium" },
  { id: "deep", label: "Deep", detail: "Sol · high" },
];
type PendingUpload = {
  key: string;
  name: string;
  mime: string;
  size: number;
  status: "uploading" | "ready" | "failed";
  id?: string;
  error?: string;
};
type VoiceDraft = { user: string; assistant: string } | null;

function MessageContent({ content }: { content: string }) {
  return (
    <div className="messageContent">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [p, setP] = useState("");
  const [e, setE] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setE("");
          try {
            await api.login(p);
            onDone();
          } catch (error) {
            setE((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="seal">D</div>
        <p className="eyebrow">REVIVED • SECURE • 2026</p>
        <h1>Agent Díaz</h1>
        <p>Your private conversational and artifact workbench.</p>
        <label>
          Owner passphrase
          <input
            type="password"
            value={p}
            onChange={(event) => setP(event.target.value)}
            autoFocus
            minLength={16}
            required
          />
        </label>
        {e && <p className="error">{e}</p>}
        <button disabled={busy}>{busy ? "Opening…" : "Enter workspace"}</button>
      </form>
    </main>
  );
}

function App() {
  const [ready, setReady] = useState<boolean | null>(null),
    [jobs, setJobs] = useState<JobView[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<
      | (JobView & { artifacts: ArtifactView[]; approvals: ApprovalView[] })
      | null
    >(null),
    [conversations, setConversations] = useState<ConversationView[]>([]),
    [conversationId, setConversationId] = useState<string | null>(null),
    [messages, setMessages] = useState<MessageView[]>([]);
  const [kind, setKind] = useState<JobKind>("chat"),
    [prompt, setPrompt] = useState(""),
    [uploads, setUploads] = useState<PendingUpload[]>([]),
    [sending, setSending] = useState(false),
    [err, setErr] = useState("");
  const [skills, setSkills] = useState<SkillView[]>([]),
    [voice, setVoice] = useState<Voice>("marin"),
    [voiceActive, setVoiceActive] = useState(false),
    [voiceStatus, setVoiceStatus] = useState("Off"),
    [voiceDraft, setVoiceDraft] = useState<VoiceDraft>(null),
    [voiceModel, setVoiceModel] = useState("");
  const chatEndRef = useRef<HTMLDivElement | null>(null),
    streamRef = useRef<{
      controller: AbortController;
      jobId: string | null;
    } | null>(null),
    voicePeerRef = useRef<RTCPeerConnection | null>(null),
    voiceMediaRef = useRef<MediaStream | null>(null),
    voiceAudioRef = useRef<HTMLAudioElement | null>(null),
    voiceUserRef = useRef(""),
    voiceAssistantRef = useRef(""),
    voicePersistingRef = useRef(false);
  const conversation = conversations.find((item) => item.id === conversationId),
    current = useMemo(
      () => detail ?? jobs.find((job) => job.id === selected) ?? null,
      [detail, jobs, selected],
    ),
    jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]),
    latestAssistantJobId = [...messages]
      .reverse()
      .find((message) => message.role === "assistant")?.jobId;
  const readyUploads = uploads.filter(
    (upload) => upload.status === "ready" && upload.id,
  ) as Array<PendingUpload & { id: string }>;

  const loadConversation = async (id: string) => {
    const result = await api.conversation(id);
    setMessages(result.messages);
    setConversations((items) =>
      items.map((item) => (item.id === id ? { ...item, ...result } : item)),
    );
  };
  const refresh = async () => {
    try {
      const [list, convos] = await Promise.all([
        api.jobs(),
        api.conversations(),
      ]);
      setJobs(list);
      setConversations(convos);
      if (selected) setDetail(await api.job(selected));
      if (conversationId && !streamRef.current)
        await loadConversation(conversationId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Workspace refresh failed";
      console.error("workspace.refresh_failed", error);
      setErr(`Connection problem: ${message}`);
    }
  };
  useEffect(() => {
    api
      .session()
      .then(() => setReady(true))
      .catch(() => setReady(false));
  }, []);
  useEffect(() => {
    if (!ready) return;
    void refresh();
    void api
      .skills()
      .then(setSkills)
      .catch((error) => {
        console.error("skills.load_failed", error);
        setErr("Díaz could not load the capability list.");
      });
    const timer = setInterval(() => void refresh(), selected ? 1800 : 15_000);
    return () => clearInterval(timer);
  }, [ready, selected, conversationId]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, voiceDraft, sending]);

  const stopVoice = () => {
    const peer = voicePeerRef.current,
      media = voiceMediaRef.current,
      audio = voiceAudioRef.current;
    voicePeerRef.current = null;
    voiceMediaRef.current = null;
    voiceAudioRef.current = null;
    peer?.close();
    media?.getTracks().forEach((track) => track.stop());
    audio?.remove();
    voiceUserRef.current = "";
    voiceAssistantRef.current = "";
    voicePersistingRef.current = false;
    setVoiceDraft(null);
    setVoiceActive(false);
    setVoiceStatus("Off");
  };
  const persistVoiceTurn = async () => {
    if (
      voicePersistingRef.current ||
      !conversationId ||
      !voiceUserRef.current.trim() ||
      !voiceAssistantRef.current.trim()
    )
      return;
    voicePersistingRef.current = true;
    const userText = voiceUserRef.current.trim(),
      assistantText = voiceAssistantRef.current.trim();
    voiceUserRef.current = "";
    voiceAssistantRef.current = "";
    try {
      await api.saveVoiceTurn(conversationId, userText, assistantText);
      await loadConversation(conversationId);
      setVoiceDraft(null);
    } catch (error) {
      console.error("voice.persist_failed", error);
      setErr(`Voice transcript was not saved: ${(error as Error).message}`);
    } finally {
      voicePersistingRef.current = false;
    }
  };
  const startVoice = async () => {
    if (!conversationId) return;
    if (sending) {
      setErr("Stop the current text response before starting voice.");
      return;
    }
    if (voiceActive) {
      stopVoice();
      return;
    }
    setErr("");
    setVoiceStatus("Connecting…");
    try {
      const token = await api.realtimeToken(conversationId, voice);
      setVoiceModel(token.model);
      const peer = new RTCPeerConnection(),
        audio = document.createElement("audio");
      voicePeerRef.current = peer;
      voiceAudioRef.current = audio;
      audio.autoplay = true;
      audio.setAttribute("aria-hidden", "true");
      document.body.appendChild(audio);
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      };
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      voiceMediaRef.current = media;
      peer.addTrack(media.getAudioTracks()[0]!, media);
      const channel = peer.createDataChannel("oai-events");
      channel.addEventListener("open", () => setVoiceStatus("Listening"));
      channel.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "input_audio_buffer.speech_started")
            setVoiceStatus("Listening");
          if (
            data.type ===
            "conversation.item.input_audio_transcription.completed"
          ) {
            voiceUserRef.current = String(data.transcript ?? "");
            setVoiceDraft({
              user: voiceUserRef.current,
              assistant: voiceAssistantRef.current,
            });
            void persistVoiceTurn();
          }
          if (
            [
              "response.output_audio_transcript.delta",
              "response.audio_transcript.delta",
            ].includes(data.type)
          ) {
            voiceAssistantRef.current += String(data.delta ?? "");
            setVoiceStatus("Speaking");
            setVoiceDraft({
              user: voiceUserRef.current,
              assistant: voiceAssistantRef.current,
            });
          }
          if (
            [
              "response.output_audio_transcript.done",
              "response.audio_transcript.done",
            ].includes(data.type)
          ) {
            voiceAssistantRef.current = String(
              data.transcript ?? voiceAssistantRef.current,
            );
            setVoiceDraft({
              user: voiceUserRef.current,
              assistant: voiceAssistantRef.current,
            });
            void persistVoiceTurn();
          }
          if (data.type === "response.done") {
            setVoiceStatus("Listening");
            void persistVoiceTurn();
          }
          if (data.type === "error")
            setErr(
              `Voice error: ${data.error?.message ?? "Realtime session failed"}`,
            );
        } catch (error) {
          console.error("voice.event_invalid", error);
        }
      });
      peer.onconnectionstatechange = () => {
        if (
          ["failed", "disconnected", "closed"].includes(peer.connectionState) &&
          voicePeerRef.current === peer
        )
          stopVoice();
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/sdp",
        },
      });
      if (!response.ok)
        throw new Error(`Realtime connection failed (${response.status})`);
      await peer.setRemoteDescription({
        type: "answer",
        sdp: await response.text(),
      });
      setVoiceActive(true);
      setVoiceStatus("Listening");
    } catch (error) {
      stopVoice();
      setErr(
        error instanceof Error ? error.message : "Microphone connection failed",
      );
    }
  };

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      setUploads((items) => [
        ...items,
        {
          key,
          name: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size,
          status: "uploading",
        },
      ]);
      try {
        const result = await api.upload([file]),
          uploaded = result.uploads[0],
          failure = result.errors[0];
        if (uploaded)
          setUploads((items) =>
            items.map((item) =>
              item.key === key
                ? { ...item, ...uploaded, status: "ready", error: undefined }
                : item,
            ),
          );
        else
          setUploads((items) =>
            items.map((item) =>
              item.key === key
                ? {
                    ...item,
                    status: "failed",
                    error: failure?.error || "File preparation failed",
                  }
                : item,
            ),
          );
      } catch (error) {
        setUploads((items) =>
          items.map((item) =>
            item.key === key
              ? { ...item, status: "failed", error: (error as Error).message }
              : item,
          ),
        );
      }
    }
  };
  const sendChat = async (retryJobId?: string) => {
    if (!conversationId || sending) return;
    if (voiceActive) {
      setErr("End the live voice session before sending a text turn.");
      return;
    }
    if (!retryJobId && uploads.some((upload) => upload.status !== "ready")) {
      setErr("Remove or reattach every file that is not ready before sending.");
      return;
    }
    const text = prompt.trim();
    if (!retryJobId && text.length < 2) return;
    const localAssistantId = `stream-${crypto.randomUUID()}`,
      controller = new AbortController(),
      attachments: AttachmentView[] = readyUploads.map((upload) => ({
        id: upload.id,
        name: upload.name,
        mime: upload.mime,
        size: upload.size,
      }));
    if (!retryJobId)
      setMessages((items) => [
        ...items,
        {
          id: `local-${crypto.randomUUID()}`,
          conversationId,
          role: "user",
          content: text,
          jobId: null,
          status: "complete",
          error: null,
          attachments,
          createdAt: new Date().toISOString(),
        },
      ]);
    setMessages((items) => [
      ...items,
      {
        id: localAssistantId,
        conversationId,
        role: "assistant",
        content: "",
        jobId: null,
        status: "streaming",
        error: null,
        attachments: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    streamRef.current = { controller, jobId: null };
    setSending(true);
    setErr("");
    if (!retryJobId) {
      setPrompt("");
      setUploads([]);
    }
    try {
      await api.streamChat(
        {
          conversationId,
          prompt: retryJobId ? undefined : text,
          fileIds: retryJobId ? [] : readyUploads.map((upload) => upload.id),
          retryJobId,
        },
        {
          onEvent: (event: ChatStreamEvent) => {
            if (event.type === "ready") {
              if (streamRef.current) streamRef.current.jobId = event.jobId;
              setMessages((items) =>
                items.map((message) =>
                  message.id === localAssistantId
                    ? { ...message, jobId: event.jobId }
                    : message,
                ),
              );
            }
            if (event.type === "delta")
              setMessages((items) =>
                items.map((message) =>
                  message.id === localAssistantId
                    ? { ...message, content: message.content + event.delta }
                    : message,
                ),
              );
            if (event.type === "approval")
              setMessages((items) =>
                items.map((message) =>
                  message.id === localAssistantId
                    ? {
                        ...message,
                        jobId: event.jobId,
                        content:
                          "Díaz needs your approval before continuing this external action.",
                        status: "streaming",
                      }
                    : message,
                ),
              );
            if (event.type === "done")
              setMessages((items) =>
                items.map((message) =>
                  message.id === localAssistantId
                    ? {
                        ...message,
                        content: event.content || message.content,
                        status: controller.signal.aborted
                          ? "stopped"
                          : "complete",
                      }
                    : message,
                ),
              );
            if (event.type === "error")
              setMessages((items) =>
                items.map((message) =>
                  message.id === localAssistantId
                    ? {
                        ...message,
                        jobId: event.jobId ?? message.jobId,
                        status: "failed",
                        error: event.error,
                      }
                    : message,
                ),
              );
          },
        },
        controller.signal,
      );
      await loadConversation(conversationId);
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        setMessages((items) =>
          items.map((message) =>
            message.id === localAssistantId
              ? {
                  ...message,
                  status: "failed",
                  error: error instanceof Error ? error.message : "Chat failed",
                }
              : message,
          ),
        );
        setErr(error instanceof Error ? error.message : "Chat failed");
      } else setTimeout(() => void loadConversation(conversationId), 350);
    } finally {
      streamRef.current = null;
      setSending(false);
      void refresh();
    }
  };
  const sendArtifact = async () => {
    if (!conversationId || prompt.trim().length < 2 || sending) return;
    if (voiceActive) {
      setErr("End the live voice session before starting an artifact job.");
      return;
    }
    setSending(true);
    setErr("");
    try {
      const job = await api.createJob({
        prompt: prompt.trim(),
        kind,
        fileIds: readyUploads.map((upload) => upload.id),
        conversationId,
      });
      setSelected(job.id);
      setPrompt("");
      setUploads([]);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setSending(false);
    }
  };
  const stopChat = () => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.controller.abort();
    if (stream.jobId) void api.cancel(stream.jobId);
  };
  const openConversation = async (id: string) => {
    stopVoice();
    setConversationId(id);
    setSelected(null);
    setDetail(null);
    setErr("");
    setUploads([]);
    await loadConversation(id);
  };
  const changeMode = async (mode: ModelMode) => {
    if (!conversationId || sending || voiceActive) return;
    try {
      const updated = await api.updateConversationMode(conversationId, mode);
      setConversations((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (error) {
      setErr((error as Error).message);
    }
  };
  const returnToConversation = async () => {
    setSelected(null);
    setDetail(null);
    if (conversationId) await loadConversation(conversationId);
  };

  if (ready === null) return <div className="boot">Waking Agent Díaz…</div>;
  if (!ready) return <Login onDone={() => setReady(true)} />;
  return (
    <div className="shell">
      <aside className="rail">
        <div>
          <div className="brand">
            <span>D</span>
            <div>
              <strong>Agent Díaz</strong>
              <small>Persistent memory</small>
            </div>
          </div>
          <button
            className="new"
            onClick={async () => {
              stopVoice();
              const created = await api.createConversation();
              setConversations(await api.conversations());
              setConversationId(created.id);
              setMessages([]);
              setSelected(null);
              setDetail(null);
            }}
          >
            + New conversation
          </button>
          <nav>
            {conversations.map((item) => (
              <button
                key={item.id}
                className={conversationId === item.id ? "active" : ""}
                onClick={() => void openConversation(item.id)}
              >
                <span
                  className={`dot ${item.status === "active" ? "completed" : ""}`}
                />
                <b>{item.title}</b>
                <small>
                  {item.status === "archived"
                    ? "Archived summary"
                    : `${item.messageCount} messages · ${item.modelMode}`}
                </small>
              </button>
            ))}
          </nav>
        </div>
        <button
          className="logout"
          onClick={async () => {
            stopVoice();
            await api.logout();
            setReady(false);
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="workspace">
        <header className="workspaceHeader">
          <div>
            <p className="eyebrow">PRIVATE AGENT WORKSPACE</p>
            <h1>{conversation?.title || "Start a conversation"}</h1>
            {conversation && (
              <p className="conversationMeta">
                Context stored · {conversation.messageCount} messages
              </p>
            )}
          </div>
          <details className="skillsPanel">
            <summary>
              Capabilities <span>{skills.length}</span>
            </summary>
            <div>
              {skills.map((skill) => (
                <article key={skill.id}>
                  <b>{skill.name}</b>
                  <small>{skill.description}</small>
                </article>
              ))}
            </div>
          </details>
        </header>
        {!conversationId ? (
          <section className="emptyState">
            <div className="seal">D</div>
            <h2>What shall we work on?</h2>
            <p>
              Create a conversation to chat, analyze files, build documents,
              make slides, or produce a portable website.
            </p>
            <button
              className="run"
              onClick={async () => {
                const created = await api.createConversation();
                setConversations(await api.conversations());
                setConversationId(created.id);
              }}
            >
              Start a conversation
            </button>
          </section>
        ) : current ? (
          <section className="result">
            <button
              className="textButton"
              onClick={() => void returnToConversation()}
            >
              ← Conversation
            </button>
            <div className="statusCard">
              <div className="statusTop">
                <span className={`pill ${current.status}`}>
                  {current.status.replace("_", " ")}
                </span>
                <strong>{current.progress}%</strong>
              </div>
              <div className="bar">
                <i style={{ width: `${current.progress}%` }} />
              </div>
              <p>{current.message}</p>
              <small>
                {current.model} · {current.reasoningEffort} reasoning
              </small>
              {!["completed", "failed", "cancelled"].includes(
                current.status,
              ) && (
                <button
                  className="danger"
                  onClick={() => api.cancel(current.id)}
                >
                  Cancel task
                </button>
              )}
              {current.error && <pre className="errorbox">{current.error}</pre>}
            </div>
            {detail?.approvals.map((approval) => (
              <div className="approval" key={approval.id}>
                <p className="eyebrow">APPROVAL REQUIRED</p>
                <h2>{approval.tool}</h2>
                <p>{approval.summary}</p>
                <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
                <div>
                  <button
                    onClick={async () => {
                      await api.decide(approval.id, "approved");
                      await refresh();
                    }}
                  >
                    Approve once
                  </button>
                  <button
                    className="danger"
                    onClick={async () => {
                      await api.decide(approval.id, "rejected");
                      await refresh();
                    }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
            {!!detail?.artifacts.length && (
              <div className="artifacts">
                <h2>Artifacts</h2>
                {detail.artifacts.map((artifact) => (
                  <a
                    key={artifact.id}
                    href={`/api/artifacts/${artifact.id}/download`}
                  >
                    <span>↓</span>
                    <div>
                      <b>{artifact.name}</b>
                      <small>
                        {(artifact.size / 1024).toFixed(1)} KB · validated
                      </small>
                    </div>
                  </a>
                ))}
              </div>
            )}
            {current.outputText && (
              <article>
                <h2>Agent result</h2>
                <pre>{current.outputText}</pre>
              </article>
            )}
            <div className="resultActions">
              {["failed", "cancelled"].includes(current.status) &&
                current.kind !== "chat" && (
                  <button
                    className="run"
                    disabled={sending}
                    onClick={async () => {
                      setSending(true);
                      try {
                        const retried = await api.retry(current.id);
                        setSelected(retried.id);
                        setDetail(null);
                      } catch (error) {
                        setErr((error as Error).message);
                      } finally {
                        setSending(false);
                      }
                    }}
                  >
                    Retry task
                  </button>
                )}
              <button
                className="new"
                onClick={() => void returnToConversation()}
              >
                Back to conversation
              </button>
            </div>
            {err && <p className="error">{err}</p>}
          </section>
        ) : (
          <section className="conversationPanel">
            <div className="conversationToolbar">
              <div
                className="modeSelector"
                role="group"
                aria-label="Model and reasoning mode"
              >
                {modes.map((mode) => (
                  <button
                    key={mode.id}
                    className={
                      conversation?.modelMode === mode.id ? "active" : ""
                    }
                    title={mode.detail}
                    disabled={sending}
                    onClick={() => void changeMode(mode.id)}
                  >
                    <b>{mode.label}</b>
                    <small>{mode.detail}</small>
                  </button>
                ))}
              </div>
              <div className="voiceControls">
                <select
                  value={voice}
                  disabled={voiceActive}
                  onChange={(event) => setVoice(event.target.value as Voice)}
                  aria-label="AI voice"
                >
                  <option value="marin">Marin</option>
                  <option value="cedar">Cedar</option>
                </select>
                <button
                  className={`mic ${voiceActive ? "active" : ""}`}
                  onClick={() => void startVoice()}
                  title={
                    voiceActive
                      ? "End voice conversation"
                      : "Start voice conversation"
                  }
                >
                  {voiceActive ? "■" : "●"}
                  <span>{voiceActive ? voiceStatus : "Voice"}</span>
                </button>
              </div>
            </div>
            {voiceActive && (
              <div className="voiceNotice">
                <span className="pulse" />
                AI voice · {voice} · {voiceModel}
              </div>
            )}
            <div className="chatlog">
              {messages.length === 0 && !voiceDraft && (
                <div className="chatWelcome">
                  <div className="seal">D</div>
                  <h2>Díaz is ready.</h2>
                  <p>
                    Chat naturally, attach a file, or choose an artifact task
                    below.
                  </p>
                </div>
              )}
              {messages.map((message) => {
                const job = message.jobId
                  ? jobsById.get(message.jobId)
                  : undefined;
                return (
                  <div
                    key={message.id}
                    className={`messageRow ${message.role}`}
                  >
                    <div className={`bubble ${message.role} ${message.status}`}>
                      <div className="bubbleLabel">
                        {message.role === "user" ? "You" : "Díaz"}
                        {message.status === "stopped" && <span>Stopped</span>}
                      </div>
                      {message.content ? (
                        <MessageContent content={message.content} />
                      ) : message.status === "streaming" ? (
                        <div className="thinking">
                          <i />
                          <i />
                          <i />
                          <span>Thinking…</span>
                        </div>
                      ) : null}
                      {message.attachments.length > 0 && (
                        <div className="messageFiles">
                          {message.attachments.map((file) => (
                            <span key={file.id}>
                              ↗ {file.name}
                              <small>{(file.size / 1024).toFixed(1)} KB</small>
                            </span>
                          ))}
                        </div>
                      )}
                      {message.error && (
                        <p className="inlineError">{message.error}</p>
                      )}
                      {message.role === "assistant" && message.jobId && (
                        <div className="bubbleActions">
                          {job?.status === "waiting_approval" && (
                            <button
                              onClick={async () => {
                                setSelected(message.jobId);
                                setDetail(await api.job(message.jobId!));
                              }}
                            >
                              Review approval
                            </button>
                          )}
                          {message.status !== "streaming" &&
                            message.jobId === latestAssistantJobId && (
                              <button
                                disabled={sending}
                                onClick={() => void sendChat(message.jobId!)}
                              >
                                ↻ Retry
                              </button>
                            )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {voiceDraft && (
                <>
                  <div className="messageRow user">
                    <div className="bubble user voiceDraft">
                      <div className="bubbleLabel">You · voice</div>
                      <p>{voiceDraft.user || "Listening…"}</p>
                    </div>
                  </div>
                  <div className="messageRow assistant">
                    <div className="bubble assistant voiceDraft">
                      <div className="bubbleLabel">Díaz · voice</div>
                      {voiceDraft.assistant ? (
                        <p>{voiceDraft.assistant}</p>
                      ) : (
                        <div className="thinking">
                          <i />
                          <i />
                          <i />
                          <span>Listening…</span>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="composerDock">
              <div className="taskPicker">
                {kinds.map((item) => (
                  <button
                    key={item.id}
                    className={kind === item.id ? "active" : ""}
                    onClick={() => setKind(item.id)}
                    title={item.hint}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {kind !== "chat" && conversation?.modelMode === "quick" && (
                <div className="recommendation">
                  <span>
                    Balanced is recommended for reliable artifact construction.
                  </span>
                  <button onClick={() => void changeMode("balanced")}>
                    Use Balanced
                  </button>
                </div>
              )}
              <div className="pendingFiles">
                {uploads.map((upload) => (
                  <span
                    key={upload.key}
                    className={upload.status}
                    title={upload.error}
                  >
                    <i>
                      {upload.status === "uploading"
                        ? "…"
                        : upload.status === "ready"
                          ? "✓"
                          : "!"}
                    </i>
                    <b>{upload.name}</b>
                    <small>
                      {upload.status === "failed"
                        ? upload.error
                        : (upload.size / 1024).toFixed(1) + " KB"}
                    </small>
                    <button
                      aria-label={`Remove ${upload.name}`}
                      onClick={() =>
                        setUploads((items) =>
                          items.filter((item) => item.key !== upload.key),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="composeBox">
                <label className="attachButton" title="Attach files">
                  ＋
                  <input
                    type="file"
                    multiple
                    onChange={(event) => {
                      if (event.target.files?.length)
                        void addFiles([...event.target.files]);
                      event.target.value = "";
                    }}
                  />
                </label>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      if (kind === "chat") void sendChat();
                      else void sendArtifact();
                    }
                  }}
                  placeholder={
                    kind === "chat"
                      ? "Message Díaz…"
                      : "Describe the finished artifact you want…"
                  }
                  rows={1}
                />
                {sending && kind === "chat" ? (
                  <button
                    className="stopButton"
                    onClick={stopChat}
                    title="Stop response"
                  >
                    ■
                  </button>
                ) : (
                  <button
                    className="sendButton"
                    disabled={
                      sending ||
                      prompt.trim().length < 2 ||
                      uploads.some((upload) => upload.status !== "ready")
                    }
                    onClick={() =>
                      kind === "chat" ? void sendChat() : void sendArtifact()
                    }
                    title="Send"
                  >
                    ↑
                  </button>
                )}
              </div>
              <div className="composerHint">
                <span>Enter to send · Shift+Enter for a new line</span>
                <span>{conversation?.modelMode} mode</span>
              </div>
              {err && <p className="error composerError">{err}</p>}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
