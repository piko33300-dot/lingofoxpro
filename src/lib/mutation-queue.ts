/**
 * LingoFox Persistent Offline Mutation & Sync Queue
 *
 * Provides a resilient, local-storage-backed FIFO queue for background operations
 * (cloud sync, quest claims, profile updates) with:
 * - Error classification: Permanent (auth, validation, 404, 409) vs. Transient (network, 5xx, 429)
 * - Dead-letter queue for tasks exceeding max retries or hitting permanent errors
 * - Exponential backoff retries with randomized jitter
 * - Automatic pause when offline & instant resumption when reconnected
 * - Concurrency mutex to prevent duplicate network races
 * - Deduplication / coalescing keys to avoid redundant operations
 * - Multi-tab synchronization via storage events
 * - Granular manual retry controls for individual and bulk failed operations
 * - React hook `useMutationQueue()` for live UI reactive status & telemetry
 */

import { useSyncExternalStore } from "react";

export type MutationStatus = "pending" | "processing" | "failed" | "completed";

export type ErrorCategory =
  | "transient"
  | "permanent"
  | "network"
  | "auth"
  | "validation"
  | "conflict";

export interface ClassifiedError {
  category: ErrorCategory;
  isPermanent: boolean;
  userMessage: string;
}

export interface MutationTask<TPayload = any> {
  id: string;
  type: string;
  payload: TPayload;
  createdAt: number;
  attempts: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  status: MutationStatus;
  lastError?: string;
  errorCategory?: ErrorCategory;
  isPermanent?: boolean;
  dedupKey?: string;
}

export interface EnqueueOptions<TPayload = any> {
  type: string;
  payload: TPayload;
  dedupKey?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export type MutationHandler<TPayload = any> = (
  payload: TPayload,
  task: MutationTask<TPayload>
) => Promise<boolean | void>;

export interface QueueStats {
  total: number;
  pending: number;
  processing: number;
  failed: number;
  completed: number;
  isOnline: boolean;
  isProcessing: boolean;
  lastProcessedAt: number | null;
  lastAttemptAt: number | null;
  nextScheduledAttemptAt: number | null;
  failedTasks: MutationTask[];
}

const STORAGE_KEY = "lingofox:mutation-queue:v1";
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000; // 1s
const DEFAULT_MAX_DELAY_MS = 30000; // 30s

// In-memory tasks store
let tasks: MutationTask[] = [];
let isInitialized = false;
let isProcessing = false;
let pendingDrainRequest = false;
let activeTimer: ReturnType<typeof setTimeout> | null = null;
let lastProcessedAt: number | null = null;

const handlers = new Map<string, MutationHandler<any>>();
const listeners = new Set<() => void>();
let cachedQueueStats: QueueStats | null = null;

function emitChange() {
  cachedQueueStats = null;
  listeners.forEach((l) => l());
}

/**
 * Classifies an unknown error into Permanent vs. Transient categories.
 * Permanent errors (401, 403, 400, 422, 404, 409, invalid credentials) are halted immediately.
 * Transient errors (network drop, timeout, 5xx, 429) back off and retry.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (!error) {
    return {
      category: "transient",
      isPermanent: false,
      userMessage: "فشل غير معروف مؤقت / Unknown transient error",
    };
  }

  const err = error as any;
  const status = Number(err?.status ?? err?.statusCode ?? err?.code ?? 0);
  const rawMessage = (err?.message || err?.error_description || String(err)).toLowerCase();

  // 1. Permanent Auth & Permission Errors
  if (
    status === 401 ||
    status === 403 ||
    rawMessage.includes("unauthorized") ||
    rawMessage.includes("jwt expired") ||
    rawMessage.includes("invalid_grant") ||
    rawMessage.includes("permission denied") ||
    rawMessage.includes("not authenticated") ||
    rawMessage.includes("auth session missing")
  ) {
    return {
      category: "auth",
      isPermanent: true,
      userMessage: "انتهت جلسة تسجيل الدخول أو تم رفض الصلاحيات (401/403)",
    };
  }

  // 2. Permanent Validation & Bad Request Errors
  if (
    status === 400 ||
    status === 422 ||
    rawMessage.includes("validation") ||
    rawMessage.includes("invalid payload") ||
    rawMessage.includes("bad request") ||
    rawMessage.includes("syntax error") ||
    rawMessage.includes("schema violation")
  ) {
    return {
      category: "validation",
      isPermanent: true,
      userMessage: "بيانات الطلب غير صالحة أو مرفوضة من الخادم (400)",
    };
  }

  // 3. Permanent Resource Not Found
  if (status === 404 || rawMessage.includes("not found")) {
    return {
      category: "permanent",
      isPermanent: true,
      userMessage: "المورد المطلوب غير موجود على الخادم (404)",
    };
  }

  // 4. Permanent Conflict / Duplicate
  if (
    status === 409 ||
    rawMessage.includes("conflict") ||
    rawMessage.includes("already claimed") ||
    rawMessage.includes("duplicate key")
  ) {
    return {
      category: "conflict",
      isPermanent: true,
      userMessage: "تعارض في البيانات: العملية مسجلة بالفعل (409)",
    };
  }

  // 5. Explicitly flagged permanent errors
  if (err?.isPermanent === true || err?.permanent === true) {
    return {
      category: "permanent",
      isPermanent: true,
      userMessage: err?.message || "خطأ دائم لا يقبل إعادة المحاولة التلقائية",
    };
  }

  // 6. Network Disconnections / Fetch Failures (Transient)
  if (
    !isNetworkOnline() ||
    rawMessage.includes("failed to fetch") ||
    rawMessage.includes("networkerror") ||
    rawMessage.includes("timeout") ||
    rawMessage.includes("abort") ||
    rawMessage.includes("econnreset") ||
    rawMessage.includes("enetunreach")
  ) {
    return {
      category: "network",
      isPermanent: false,
      userMessage: "انقطاع أو بطء في اتصال الشبكة بالخادم",
    };
  }

  // 7. Rate Limits (Transient with backoff)
  if (
    status === 429 ||
    rawMessage.includes("rate limit") ||
    rawMessage.includes("too many requests")
  ) {
    return {
      category: "transient",
      isPermanent: false,
      userMessage: "تجاوز حد الطلبات المسموح به مؤقتاً (429)",
    };
  }

  // 8. Server 5xx Internal Errors (Transient)
  if (status >= 500 && status < 600) {
    return {
      category: "transient",
      isPermanent: false,
      userMessage: `الخادم غير متاح مؤقتاً (${status})`,
    };
  }

  // Default to transient error
  return {
    category: "transient",
    isPermanent: false,
    userMessage: err?.message || "تعذر إكمال العملية مؤقتاً",
  };
}

/**
 * Calculates exponential backoff delay based on attempt count.
 * Formula: min(maxDelay, baseDelay * 2^attempts) + optional jitter (0-25%).
 */
export function calculateBackoff(
  attempts: number,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
  withJitter: boolean = true
): number {
  const safeAttempts = Math.max(0, attempts);
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, safeAttempts));
  if (!withJitter) return exponential;
  const jitter = Math.floor(Math.random() * (baseDelayMs * 0.25));
  return Math.min(maxDelayMs, exponential + jitter);
}

/** Check if current runtime environment is considered online. */
export function isNetworkOnline(): boolean {
  if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
    return navigator.onLine;
  }
  return true;
}

/** Loads tasks from persistent storage (safe for SSR). */
function loadTasksFromStorage(): MutationTask[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return tasks;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sanitize tasks
    return parsed.filter(
      (t) =>
        t &&
        typeof t.id === "string" &&
        typeof t.type === "string" &&
        typeof t.status === "string"
    );
  } catch (e) {
    console.warn("Failed to load mutation queue from storage:", e);
    return [];
  }
}

/** Saves tasks to persistent storage (safe for SSR). */
function saveTasksToStorage(currentTasks: MutationTask[]) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    // Keep max 15 completed tasks to prevent unbounded growth
    const activeTasks = currentTasks.filter((t) => t.status !== "completed");
    const completedTasks = currentTasks
      .filter((t) => t.status === "completed")
      .slice(-15);
    const toSave = [...activeTasks, ...completedTasks];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.warn("Failed to persist mutation queue to storage:", e);
  }
}

/**
 * Registers an asynchronous handler function for a specific mutation type.
 */
export function registerMutationHandler<T = any>(
  type: string,
  handler: MutationHandler<T>
): () => void {
  handlers.set(type, handler);
  // Auto-schedule processing if there are pending tasks of this type
  if (isInitialized && tasks.some((t) => t.type === type && t.status === "pending")) {
    void processQueue();
  }
  return () => {
    handlers.delete(type);
  };
}

/**
 * Enqueues a new mutation task into the persistent queue.
 * Supports coalescing / deduplication when `dedupKey` is provided.
 */
export function enqueueMutation<T = any>(options: EnqueueOptions<T>): string {
  ensureInitialized();

  const {
    type,
    payload,
    dedupKey,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
  } = options;

  // Deduplication check: if a task with the same dedupKey is pending, processing, or failed, coalesce it
  if (dedupKey) {
    const existingIndex = tasks.findIndex(
      (t) =>
        t.dedupKey === dedupKey &&
        (t.status === "pending" || t.status === "processing" || t.status === "failed")
    );

    if (existingIndex >= 0) {
      const existing = tasks[existingIndex]!;
      const updated: MutationTask<T> = {
        ...existing,
        payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: Date.now(),
      };
      delete updated.lastError;
      delete updated.errorCategory;
      delete updated.isPermanent;
      tasks[existingIndex] = updated;
      saveTasksToStorage(tasks);
      emitChange();
      scheduleDrain();
      return updated.id;
    }
  }

  const id = `mut_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const newTask: MutationTask<T> = {
    id,
    type,
    payload,
    createdAt: Date.now(),
    attempts: 0,
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    nextAttemptAt: Date.now(),
    status: "pending",
    ...(dedupKey !== undefined ? { dedupKey } : {}),
  };

  tasks.push(newTask);
  saveTasksToStorage(tasks);
  emitChange();
  scheduleDrain();

  return id;
}

/**
 * Schedules a queue drain immediately or at the earliest nextAttemptAt.
 */
function scheduleDrain() {
  if (!isNetworkOnline()) return;

  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }

  const now = Date.now();
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  if (pendingTasks.length === 0) return;

  // Find earliest scheduled attempt
  const earliest = Math.min(...pendingTasks.map((t) => t.nextAttemptAt));
  // Guarantee a minimum delay of 30ms to prevent synchronous call-stack recursion
  const delay = Math.max(30, earliest - now);

  activeTimer = setTimeout(() => {
    activeTimer = null;
    void processQueue();
  }, delay);
}

/**
 * Processes the persistent queue, respecting exponential backoff, error classifications, and offline state.
 * Protected by a concurrency mutex to guarantee serialized execution per task.
 */
export async function processQueue(force: boolean = false): Promise<{
  processed: number;
  failed: number;
  remaining: number;
}> {
  ensureInitialized();

  if (!isNetworkOnline() && !force) {
    emitChange();
    return { processed: 0, failed: 0, remaining: getPendingCount() };
  }

  if (isProcessing) {
    pendingDrainRequest = true;
    return { processed: 0, failed: 0, remaining: getPendingCount() };
  }

  isProcessing = true;
  emitChange();

  let processed = 0;
  let failed = 0;

  try {
    const now = Date.now();

    // Eligible tasks: pending and due for execution (or forced)
    const eligibleTasks = tasks
      .filter((t) => t.status === "pending" && (force || t.nextAttemptAt <= now))
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const task of eligibleTasks) {
      if (!isNetworkOnline() && !force) {
        break; // Stop processing further tasks if connection drops mid-drain
      }

      const handler = handlers.get(task.type);
      if (!handler) {
        // No handler registered yet for this type — keep pending until registered
        continue;
      }

      task.status = "processing";
      task.lastAttemptAt = Date.now();
      saveTasksToStorage(tasks);
      emitChange();

      try {
        const result = await handler(task.payload, task);
        if (result === false) {
          throw new Error("Task handler returned unsuccessful status");
        }

        task.status = "completed";
        delete task.lastError;
        delete task.errorCategory;
        delete task.isPermanent;
        processed++;
      } catch (err: any) {
        task.attempts += 1;
        const classified = classifyError(err);
        task.lastError = classified.userMessage;
        task.errorCategory = classified.category;
        task.isPermanent = classified.isPermanent;

        // Permanent error OR exceeded max retries -> Move to Dead-Letter (failed) list
        if (classified.isPermanent || task.attempts >= task.maxRetries) {
          task.status = "failed";
          failed++;
        } else {
          // Transient error with retries remaining -> Schedule exponential backoff
          task.status = "pending";
          const backoff = calculateBackoff(
            task.attempts,
            task.baseDelayMs,
            task.maxDelayMs,
            true
          );
          task.nextAttemptAt = Date.now() + backoff;
        }
      }

      saveTasksToStorage(tasks);
      emitChange();
    }

    lastProcessedAt = Date.now();
  } finally {
    isProcessing = false;
    saveTasksToStorage(tasks);
    emitChange();

    if (pendingDrainRequest) {
      pendingDrainRequest = false;
    }
    scheduleDrain();
  }

  return { processed, failed, remaining: getPendingCount() };
}

/** Resets backoff and manually retries all failed (dead-letter) tasks. */
export async function retryFailedMutations(): Promise<{
  processed: number;
  failed: number;
  remaining: number;
}> {
  ensureInitialized();
  const now = Date.now();
  let modified = false;

  for (const t of tasks) {
    if (t.status === "failed") {
      t.status = "pending";
      t.attempts = 0;
      t.nextAttemptAt = now;
      delete t.lastError;
      delete t.errorCategory;
      delete t.isPermanent;
      modified = true;
    }
  }

  if (modified) {
    saveTasksToStorage(tasks);
    emitChange();
    return await processQueue(true);
  }
  return { processed: 0, failed: 0, remaining: getPendingCount() };
}

/** Manually retries a single specific failed mutation task. */
export async function retryMutation(taskId: string): Promise<{
  processed: number;
  failed: number;
  remaining: number;
}> {
  ensureInitialized();
  const task = tasks.find((t) => t.id === taskId);
  if (task && task.status === "failed") {
    task.status = "pending";
    task.attempts = 0;
    task.nextAttemptAt = Date.now();
    delete task.lastError;
    delete task.errorCategory;
    delete task.isPermanent;
    saveTasksToStorage(tasks);
    emitChange();
    return await processQueue(true);
  }
  return { processed: 0, failed: 0, remaining: getPendingCount() };
}

/** Cancels and removes a specific mutation task from the queue. */
export function cancelMutation(taskId: string): boolean {
  ensureInitialized();
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index >= 0) {
    tasks.splice(index, 1);
    saveTasksToStorage(tasks);
    emitChange();
    return true;
  }
  return false;
}

/** Dismisses a failed task (alias for cancelMutation for UI clarity). */
export function dismissMutation(taskId: string): boolean {
  return cancelMutation(taskId);
}

/** Clears all completed mutation tasks from memory and storage. */
export function clearCompletedMutations(): void {
  ensureInitialized();
  tasks = tasks.filter((t) => t.status !== "completed");
  saveTasksToStorage(tasks);
  emitChange();
}

/** Clears the entire queue (useful for testing or total account reset). */
export function clearAllMutations(): void {
  ensureInitialized();
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  tasks = [];
  saveTasksToStorage(tasks);
  emitChange();
}

/** Returns live snapshot copy of all tasks in the queue. */
export function getQueueTasks(): MutationTask[] {
  ensureInitialized();
  return [...tasks];
}

/** Returns all failed (dead-letter) mutation tasks. */
export function getFailedMutations(): MutationTask[] {
  ensureInitialized();
  return tasks.filter((t) => t.status === "failed");
}

/** Returns all pending mutation tasks. */
export function getPendingMutations(): MutationTask[] {
  ensureInitialized();
  return tasks.filter((t) => t.status === "pending" || t.status === "processing");
}

function getPendingCount(): number {
  return tasks.filter((t) => t.status === "pending" || t.status === "processing").length;
}

/** Returns overall queue statistics for live telemetry and UI badges. */
export function getQueueStats(): QueueStats {
  ensureInitialized();
  if (cachedQueueStats) return cachedQueueStats;

  let pending = 0;
  let processing = 0;
  let failed = 0;
  let completed = 0;
  let nextScheduledAttemptAt: number | null = null;
  let latestAttemptAt: number | null = lastProcessedAt;
  const failedTasks: MutationTask[] = [];

  for (const t of tasks) {
    if (t.lastAttemptAt && (latestAttemptAt === null || t.lastAttemptAt > latestAttemptAt)) {
      latestAttemptAt = t.lastAttemptAt;
    }

    if (t.status === "pending") {
      pending++;
      if (nextScheduledAttemptAt === null || t.nextAttemptAt < nextScheduledAttemptAt) {
        nextScheduledAttemptAt = t.nextAttemptAt;
      }
    } else if (t.status === "processing") {
      processing++;
    } else if (t.status === "failed") {
      failed++;
      failedTasks.push({ ...t });
    } else if (t.status === "completed") {
      completed++;
    }
  }

  cachedQueueStats = {
    total: tasks.length,
    pending,
    processing,
    failed,
    completed,
    isOnline: isNetworkOnline(),
    isProcessing,
    lastProcessedAt,
    lastAttemptAt: latestAttemptAt,
    nextScheduledAttemptAt,
    failedTasks,
  };
  return cachedQueueStats;
}

/**
 * Human-readable relative time helper for telemetry and badges.
 */
export function formatTimeDifference(
  timestamp: number | null,
  now: number = Date.now(),
  isFuture: boolean = false,
  lang: "ar" | "en" = "ar"
): string {
  if (!timestamp) {
    return lang === "ar" ? "لا يوجد" : "None";
  }
  const diffMs = isFuture ? timestamp - now : now - timestamp;
  if (diffMs <= 0 && isFuture) {
    return lang === "ar" ? "الآن" : "Now";
  }
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 5 && !isFuture) {
    return lang === "ar" ? "الآن" : "Just now";
  }
  if (sec < 60) {
    return lang === "ar"
      ? isFuture
        ? `خلال ${sec} ثانية`
        : `قبل ${sec} ثانية`
      : isFuture
      ? `in ${sec}s`
      : `${sec}s ago`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return lang === "ar"
      ? isFuture
        ? `خلال ${min} دقيقة`
        : `قبل ${min} دقيقة`
      : isFuture
      ? `in ${min}m`
      : `${min}m ago`;
  }
  const d = new Date(timestamp);
  return d.toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Initializes the mutation queue event listeners:
 * - Online / Offline network triggers
 * - Visibility change triggers
 * - Multi-tab storage sync
 */
export function startMutationQueue(): void {
  ensureInitialized();
}

function ensureInitialized() {
  if (isInitialized) return;
  isInitialized = true;

  tasks = loadTasksFromStorage();

  if (typeof window !== "undefined") {
    // 1. Online: immediately reset backoff of pending tasks and drain
    window.addEventListener("online", () => {
      const now = Date.now();
      for (const t of tasks) {
        if (t.status === "pending" && t.nextAttemptAt > now) {
          t.nextAttemptAt = now;
        }
      }
      saveTasksToStorage(tasks);
      emitChange();
      void processQueue(true);
    });

    // 2. Offline: emit change to notify UI
    window.addEventListener("offline", () => {
      if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = null;
      }
      emitChange();
    });

    // 3. Tab Visibility change: drain on foreground return
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && isNetworkOnline()) {
          void processQueue();
        }
      });
    }

    // 4. Cross-tab storage synchronization
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY) {
        tasks = loadTasksFromStorage();
        emitChange();
        scheduleDrain();
      }
    });

    // Initial check on startup
    scheduleDrain();
  }
}

function subscribeQueue(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const serverStatsSnapshot: QueueStats = {
  total: 0,
  pending: 0,
  processing: 0,
  failed: 0,
  completed: 0,
  isOnline: true,
  isProcessing: false,
  lastProcessedAt: null,
  lastAttemptAt: null,
  nextScheduledAttemptAt: null,
  failedTasks: [],
};

/**
 * React hook to reactively subscribe to the mutation queue status and counts.
 */
export function useMutationQueue(): QueueStats {
  return useSyncExternalStore(subscribeQueue, getQueueStats, () => serverStatsSnapshot);
}
