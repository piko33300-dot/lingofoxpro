import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  Info,
  Loader2,
  Mic,
  MicOff,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAccount } from "@/lib/account";
import { useT, type I18nKey } from "@/lib/i18n";
import { getCourse, type Course } from "@/lib/lessons";
import { progressActions, useProgress } from "@/lib/progress-store";
import { TUTOR_MAX_INPUT, parseTutorContent, type TutorMessage } from "@/lib/tutor";
import { canSpeak, speak, stopSpeaking } from "@/lib/speech";
import {
  getVoiceCapability,
  isSpeechRecognitionSupported,
  SpeechRecognizer,
  type VoiceCapability,
} from "@/lib/speech-recognition";
import { cn } from "@/lib/utils";
import { AppPage, BottomNav } from "@/components/lingo/BottomNav";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, type PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { FoxMascot, type FoxMood } from "@/components/lingo/FoxMascot";

export const Route = createFileRoute("/tutor")({
  head: () => ({
    meta: [
      { title: "تحدّث مع فوكس — معلّمك الذكي | LingoFox" },
      { name: "description", content: "محادثة صوتية وكتابية حقيقية مع معلّم ذكي يصحّح أخطاءك فوراً بالإنجليزية والإسبانية والفرنسية والتركية والألمانية والعربية." },
    ],
  }),
  component: Tutor,
});

const STARTERS: I18nKey[] = ["tutorStarter1", "tutorStarter2", "tutorStarter3", "tutorStarter4"];

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg", "audio/wav"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function Tutor() {
  const { user, ready } = useAccount();
  const { t, loc } = useT();
  const p = useProgress();
  const course = getCourse(p.course) ?? getCourse("en")!;
  const [mood, setMood] = useState<FoxMood>("neutral");

  return (
    <AppPage>
      <div className="mx-auto flex h-[calc(100dvh-5rem)] max-w-2xl flex-col px-4 pt-3 pb-2 sm:h-[calc(100dvh-5.5rem)]">
        <header className="mb-3 flex items-center justify-between gap-3 border-b-2 border-border pb-3">
          <div className="flex items-center gap-3">
            <div className="relative grid size-12 place-items-center rounded-2xl bg-primary/15 ring-2 ring-primary/20">
              <FoxMascot mood={mood} size="sm" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-display text-lg font-bold text-secondary">{t("tutorTitle")}</h1>
                <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                  <Sparkles className="size-3" />
                  {course.flag} {loc(course.title)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{t("tutorSub")}</p>
            </div>
          </div>
        </header>

        {!ready ? (
          <p className="m-auto text-muted-foreground">{t("loading")}</p>
        ) : !user ? (
          <div className="m-auto max-w-xs p-6 text-center">
            <FoxMascot mood="encourage" size="lg" className="mx-auto" />
            <p className="mt-4 font-semibold text-secondary">{t("tutorGuest")}</p>
            <Link
              to="/auth"
              className="btn-3d mt-5 block bg-primary px-6 py-3 font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-shade)]"
            >
              {t("signIn")}
            </Link>
          </div>
        ) : (
          <TutorChat userId={user.id} course={course} onMoodChange={setMood} />
        )}
      </div>
      <BottomNav />
    </AppPage>
  );
}

function TutorChat({
  userId,
  course,
  onMoodChange,
}: {
  userId: string;
  course: Course;
  onMoodChange: (mood: FoxMood) => void;
}) {
  const { t, lang } = useT();
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<"ready" | "submitted" | "streaming" | "error">("ready");
  const [draft, setDraft] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("lingofox_tutor_autoplay") === "true";
  });
  const [isRecording, setIsRecording] = useState(false);
  const [recordingMethod, setRecordingMethod] = useState<"speech_api" | "media_recorder" | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [showVoiceHelp, setShowVoiceHelp] = useState(false);
  const [capability, setCapability] = useState<VoiceCapability>({
    liveRecognition: false,
    audioRecording: false,
    hasVoiceInput: false,
  });

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);

  // Detect voice capabilities once on client mount
  useEffect(() => {
    setCapability(getVoiceCapability());
  }, []);

  // Update header mascot mood based on conversation state
  useEffect(() => {
    if (status === "submitted" || isTranscribing) {
      onMoodChange("thinking");
    } else if (status === "streaming" || playingId !== null) {
      onMoodChange("speaking");
    } else {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && last.content.includes("✏️")) {
        onMoodChange("encourage");
      } else {
        onMoodChange("neutral");
      }
    }
  }, [status, playingId, isTranscribing, messages, onMoodChange]);

  // Clean up any audio or recording when unmounting
  useEffect(() => {
    return () => {
      stopSpeaking();
      recognizerRef.current?.abort();
      if (mediaRecRef.current?.state === "recording") {
        mediaRecRef.current.stream.getTracks().forEach((tr) => tr.stop());
      }
    };
  }, []);

  // Max 30 seconds timer for MediaRecorder fallback
  useEffect(() => {
    if (isRecording && recordingMethod === "media_recorder") {
      setRecordSeconds(0);
      const interval = window.setInterval(() => {
        setRecordSeconds((s) => {
          if (s >= 30) {
            stopRecording();
            return s;
          }
          return s + 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
    return undefined;
  }, [isRecording, recordingMethod]);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from("tutor_messages")
      .select("id, role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(200)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) toast.error(t("tutorError"));
        setMessages((data ?? []).map((m) => ({ id: m.id, role: m.role as TutorMessage["role"], content: m.content })));
        setLoaded(true);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => { if (status === "ready") inputRef.current?.focus(); }, [status, loaded]);

  function toggleAutoPlay() {
    const next = !autoPlay;
    setAutoPlay(next);
    localStorage.setItem("lingofox_tutor_autoplay", String(next));
    toast.success(next ? t("tutorAutoPlay") + " (مفعّل)" : t("tutorAutoPlay") + " (معطّل)");
  }

  function handlePlaySpeech(id: string, text: string, slow = false) {
    if (playingId === id) {
      stopSpeaking();
      setPlayingId(null);
      return;
    }
    stopSpeaking();
    setPlayingId(id);
    speak(text, course.target, {
      slow,
      onStart: () => setPlayingId(id),
      onEnd: () => setPlayingId(null),
    });
  }

  async function send(text: string) {
    const message = text.trim().slice(0, TUTOR_MAX_INPUT);
    if (!message || status === "submitted" || status === "streaming") return;
    stopSpeaking();
    setPlayingId(null);
    const userMsg: TutorMessage = { id: `u-${Date.now()}`, role: "user", content: message };
    const replyId = `a-${Date.now()}`;
    setMessages((m) => [...m, userMsg]);
    setDraft("");
    setStatus("submitted");
    const controller = new AbortController();
    abortRef.current = controller;
    let accumulated = "";
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch("/api/tutor", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message, course: course.id, ui: lang, level: progressActions.get().lessonsDone }),
      });
      if (!res.ok || !res.body) {
        const code = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(code.error === "daily_limit" ? t("tutorLimit") : code.error === "ai_not_configured" ? t("aiNotConfigured") : t("tutorError"));
        setStatus("ready");
        return;
      }
      setStatus("streaming");
      setMessages((m) => [...m, { id: replyId, role: "assistant", content: "" }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, content: x.content + chunk } : x)));
      }
      setStatus("ready");

      if (autoPlay && accumulated.trim()) {
        const parsed = parseTutorContent(accumulated);
        handlePlaySpeech(replyId, parsed.reply || accumulated);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") toast.error(t("tutorError"));
      setStatus("ready");
    } finally {
      abortRef.current = null;
    }
  }

  // Voice input handling (Web Speech API with MediaRecorder fallback)
  async function startRecording() {
    if (isRecording) {
      stopRecording();
      return;
    }

    const cap = getVoiceCapability();
    if (!cap.hasVoiceInput) {
      toast.error(t("tutorVoiceNoAudioHardware") + " " + t("tutorVoiceBrowserTips"));
      setShowVoiceHelp(true);
      return;
    }

    // 1. If Web Speech API is supported, use real-time speech recognition
    if (cap.liveRecognition) {
      try {
        const rec = new SpeechRecognizer(course.target, {
          onStart: () => {
            setIsRecording(true);
            setRecordingMethod("speech_api");
          },
          onResult: (transcript) => {
            setDraft(transcript);
          },
          onError: (kind) => {
            setIsRecording(false);
            setRecordingMethod(null);
            if (kind === "not-allowed") {
              toast.error(t("tutorVoiceNoMic"));
            } else if (kind === "no-speech") {
              toast.error(t("tutorVoiceNoSpeechDetected"));
            } else if (kind === "audio-capture") {
              toast.error(t("tutorVoiceNoAudioHardware"));
            } else {
              void startMediaRecorderFallback();
            }
          },
          onEnd: () => {
            setIsRecording(false);
            setRecordingMethod(null);
          },
        });
        recognizerRef.current = rec;
        rec.start();
        return;
      } catch {
        // Fall back to MediaRecorder
      }
    }

    // 2. MediaRecorder fallback for browsers without Web Speech API
    await startMediaRecorderFallback();
  }

  async function startMediaRecorderFallback() {
    try {
      toast.info(t("tutorVoiceUnsupportedNotice"), { duration: 3500 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) mediaChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const audioBlob = new Blob(mediaChunksRef.current, { type: rec.mimeType || mime || "audio/webm" });
        void checkTranscribe(audioBlob);
      };
      mediaRecRef.current = rec;
      rec.start();
      setIsRecording(true);
      setRecordingMethod("media_recorder");
    } catch {
      setIsRecording(false);
      setRecordingMethod(null);
      toast.error(t("tutorVoiceNoMic"));
    }
  }

  function stopRecording() {
    if (recordingMethod === "speech_api") {
      recognizerRef.current?.stop();
    } else if (recordingMethod === "media_recorder") {
      if (mediaRecRef.current?.state === "recording") {
        mediaRecRef.current.stop();
      }
    }
    setIsRecording(false);
    setRecordingMethod(null);
  }

  async function checkTranscribe(audio: Blob) {
    if (audio.size < 500) {
      toast.error(t("tutorVoiceNoSpeechDetected"));
      return;
    }
    setIsTranscribing(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const form = new FormData();
      form.append("audio", audio);
      form.append("lang", course.target);
      const res = await fetch("/api/speak", {
        method: "POST",
        body: form,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const result = (await res.json()) as { heard?: string };
        if (result.heard?.trim()) {
          setDraft((prev) => (prev ? prev + " " + result.heard!.trim() : result.heard!.trim()));
          toast.success(t("tutorVoiceInput") + " ✓");
        } else {
          toast.error(t("tutorVoiceNoSpeechDetected"));
        }
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (err?.error === "daily_limit") {
          toast.error(t("speakLimit"));
        } else {
          toast.error(t("tutorVoiceNoSpeechDetected"));
        }
      }
    } catch {
      toast.error(t("tutorVoiceNoSpeechDetected"));
    } finally {
      setIsTranscribing(false);
    }
  }

  async function clearChat() {
    stopSpeaking();
    setPlayingId(null);
    const { error } = await supabase.from("tutor_messages").delete().eq("user_id", userId);
    if (error) { toast.error(t("tutorError")); return; }
    setMessages([]);
    toast.success(t("tutorCleared"));
  }

  const busy = status === "submitted" || status === "streaming";

  return (
    <>
      <Conversation className="min-h-0 flex-1 rounded-3xl border-2 border-border bg-card">
        <ConversationContent className="gap-5 p-4">
          {loaded && messages.length === 0 && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <FoxMascot mood="neutral" size="lg" />
              <p className="font-display font-semibold text-secondary">{t("tutorEmpty")}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {STARTERS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy}
                    onClick={() => void send(t(k))}
                    className="rounded-full border-2 border-border bg-background px-3 py-1 text-xs font-semibold text-secondary transition-colors hover:border-primary disabled:opacity-50"
                  >
                    {t(k)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => {
            const isAssistant = m.role === "assistant";
            const isPlaying = playingId === m.id;
            const parsed = isAssistant ? parseTutorContent(m.content) : null;
            const textToSpeak = parsed ? parsed.reply : m.content;

            return (
              <Message key={m.id} from={m.role}>
                <MessageContent className={cn(isAssistant && "w-full max-w-full")}>
                  {isAssistant ? (
                    <div className="space-y-2">
                      {parsed?.correction && (
                        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs">
                          <p className="font-bold text-primary">✏️ {t("tutorCorrectionTitle")}</p>
                          <p className="mt-1 text-foreground/90">{parsed.correction}</p>
                        </div>
                      )}
                      <MessageResponse isAnimating={status === "streaming" && m === messages[messages.length - 1]}>
                        {parsed ? parsed.reply : m.content}
                      </MessageResponse>
                      {status !== "streaming" && textToSpeak.trim() && (
                        <div className="flex items-center gap-2 border-t border-border/40 pt-1.5">
                          <button
                            type="button"
                            onClick={() => handlePlaySpeech(m.id, textToSpeak)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors",
                              isPlaying
                                ? "bg-primary text-primary-foreground animate-pulse"
                                : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"
                            )}
                            title={t("tutorListen")}
                          >
                            {isPlaying ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
                            <span>{isPlaying ? t("speakStop") : t("tutorListen")}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handlePlaySpeech(m.id, textToSpeak, true)}
                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                            title={t("tutorListenSlow")}
                          >
                            <span>🐢 {t("slow")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  )}
                </MessageContent>
              </Message>
            );
          })}

          {status === "submitted" && (
            <Message from="assistant">
              <MessageContent>
                <Shimmer>{t("tutorThinking")}</Shimmer>
              </MessageContent>
            </Message>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Browser Fallback Notice when Web Speech API is missing */}
      {!capability.liveRecognition && capability.audioRecording && (
        <div className="mt-2 flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs text-secondary">
          <div className="flex items-center gap-1.5">
            <Info className="size-3.5 text-primary shrink-0" />
            <span>{t("tutorVoiceFallbackActive")}</span>
          </div>
          <button
            type="button"
            onClick={() => setShowVoiceHelp(true)}
            className="font-bold text-primary hover:underline"
          >
            {lang === "ar" ? "تفاصيل" : "Details"}
          </button>
        </div>
      )}

      {/* Active Recording or Transcribing Status */}
      {isRecording && (
        <div className="mt-2 flex items-center justify-between rounded-2xl border-2 border-destructive/40 bg-destructive/10 px-4 py-2.5 animate-pulse">
          <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <Mic className="size-4 animate-bounce" />
            <span>
              {recordingMethod === "speech_api"
                ? t("tutorVoiceListening")
                : `${t("tutorVoiceRecordMode")} (${Math.floor(recordSeconds / 60)}:${String(recordSeconds % 60).padStart(2, "0")} / 0:30)`}
            </span>
          </div>
          <button
            type="button"
            onClick={stopRecording}
            className="flex items-center gap-1.5 rounded-xl bg-destructive px-3 py-1 text-xs font-bold text-destructive-foreground hover:brightness-110"
          >
            <Square className="size-3 fill-current" />
            <span>{recordingMethod === "speech_api" ? t("speakStop") : t("tutorVoiceStopRecording")}</span>
          </button>
        </div>
      )}

      {isTranscribing && (
        <div className="mt-2 flex items-center justify-center gap-2 rounded-2xl border-2 border-primary/40 bg-primary/10 px-4 py-2.5 text-sm font-semibold text-primary animate-pulse">
          <Loader2 className="size-4 animate-spin" />
          <span>{t("tutorVoiceTranscribing")}</span>
        </div>
      )}

      <div className="py-2.5">
        <PromptInput onSubmit={(msg: PromptInputMessage) => void send(msg.text)} className="rounded-2xl border-2 border-border bg-card">
          <PromptInputTextarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={TUTOR_MAX_INPUT}
            placeholder={isRecording ? t("tutorVoiceListening") : t("tutorPlaceholder")}
            dir="auto"
          />
          <PromptInputFooter className="justify-between">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void clearChat()}
                disabled={busy || messages.length === 0}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                title={t("tutorClear")}
              >
                <RotateCcw className="size-3.5" />
                <span className="hidden sm:inline">{t("tutorClear")}</span>
              </button>

              <button
                type="button"
                onClick={toggleAutoPlay}
                className={cn(
                  "flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold transition-colors",
                  autoPlay ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground"
                )}
                title={t("tutorAutoPlay")}
              >
                <Volume2 className="size-3.5" />
                <span className="hidden sm:inline">{t("tutorAutoPlay")}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowVoiceHelp(true)}
                className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={lang === "ar" ? "إرشادات وتوافق المتصفح مع الصوت" : "Voice & browser compatibility guide"}
              >
                <HelpCircle className="size-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={isRecording ? stopRecording : () => void startRecording()}
                disabled={busy || isTranscribing}
                aria-label={t("tutorVoiceInput")}
                title={
                  !capability.hasVoiceInput
                    ? t("tutorVoiceNoAudioHardware")
                    : !capability.liveRecognition
                      ? t("tutorVoiceRecordMode")
                      : t("tutorVoiceLiveMode")
                }
                className={cn(
                  "grid size-9 place-items-center rounded-xl transition-all active:scale-95 disabled:opacity-40",
                  isRecording
                    ? "bg-destructive text-destructive-foreground animate-pulse"
                    : isTranscribing
                      ? "bg-primary/20 text-primary animate-pulse"
                      : "bg-muted text-muted-foreground hover:bg-primary/20 hover:text-primary"
                )}
              >
                {isRecording ? (
                  <Square className="size-4 fill-current" />
                ) : isTranscribing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : !capability.hasVoiceInput ? (
                  <MicOff className="size-4 text-muted-foreground/60" />
                ) : (
                  <Mic className="size-4" />
                )}
              </button>

              <PromptInputSubmit status={status} disabled={!busy && !draft.trim()} onStop={() => abortRef.current?.abort()} />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>

      {/* Voice Compatibility Guide Modal */}
      {showVoiceHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/60 p-4 backdrop-blur-sm"
          onClick={() => setShowVoiceHelp(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-3xl border-2 border-border bg-card p-6 shadow-elevated animate-slide-up"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <FoxMascot mood="neutral" size="sm" />
                <div>
                  <h3 className="font-display font-bold text-secondary">
                    {lang === "ar" ? "توافق المتصفح مع الصوت" : "Browser Voice Guide"}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {lang === "ar" ? "حالة الصوت في متصفحك الحالي" : "Voice features in your current browser"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowVoiceHelp(false)}
                className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-4 space-y-2 text-xs">
              <div className="flex items-center justify-between rounded-xl bg-muted/60 p-2.5">
                <span className="font-medium text-foreground">{t("tutorVoiceLiveMode")} (Web Speech API)</span>
                {capability.liveRecognition ? (
                  <span className="flex items-center gap-1 font-bold text-forest">
                    <CheckCircle2 className="size-3.5" />
                    {lang === "ar" ? "مدعوم" : "Supported"}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 font-bold text-amber-600">
                    <AlertCircle className="size-3.5" />
                    {lang === "ar" ? "غير مدعوم" : "Unsupported"}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between rounded-xl bg-muted/60 p-2.5">
                <span className="font-medium text-foreground">{t("tutorVoiceRecordMode")} (MediaRecorder)</span>
                {capability.audioRecording ? (
                  <span className="flex items-center gap-1 font-bold text-forest">
                    <CheckCircle2 className="size-3.5" />
                    {lang === "ar" ? "متاح كبديل" : "Available fallback"}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 font-bold text-destructive">
                    <AlertCircle className="size-3.5" />
                    {lang === "ar" ? "غير متاح" : "Unavailable"}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between rounded-xl bg-muted/60 p-2.5">
                <span className="font-medium text-foreground">{t("tutorListen")} (SpeechSynthesis)</span>
                {canSpeak() ? (
                  <span className="flex items-center gap-1 font-bold text-forest">
                    <CheckCircle2 className="size-3.5" />
                    {lang === "ar" ? "مدعوم" : "Supported"}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 font-bold text-amber-600">
                    <AlertCircle className="size-3.5" />
                    {lang === "ar" ? "غير مدعوم" : "Unsupported"}
                  </span>
                )}
              </div>
            </div>

            <div className="mt-4 rounded-2xl bg-primary/10 p-3 text-xs text-secondary">
              <p className="font-semibold text-primary">{lang === "ar" ? "💡 نصيحة لأفضل تجربة:" : "💡 Recommended browsers:"}</p>
              <p className="mt-1 leading-relaxed text-muted-foreground">{t("tutorVoiceBrowserTips")}</p>
            </div>

            <button
              type="button"
              onClick={() => setShowVoiceHelp(false)}
              className="btn-3d mt-5 w-full bg-primary py-2.5 font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-shade)]"
            >
              {t("continue")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
