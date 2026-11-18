import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  calculateBackoff,
  classifyError,
  enqueueMutation,
  processQueue,
  registerMutationHandler,
  retryFailedMutations,
  retryMutation,
  dismissMutation,
  cancelMutation,
  clearAllMutations,
  getQueueTasks,
  getFailedMutations,
  getPendingMutations,
  getQueueStats,
  formatTimeDifference,
  startMutationQueue,
} from "@/lib/mutation-queue";

describe("Mutation Queue, Error Classification & Telemetry Engine", () => {
  beforeEach(() => {
    clearAllMutations();
    localStorage.clear();
    startMutationQueue();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearAllMutations();
    vi.restoreAllMocks();
  });

  describe("calculateBackoff", () => {
    it("calculates exact deterministic exponential backoff when jitter is disabled", () => {
      expect(calculateBackoff(0, 1000, 30000, false)).toBe(1000); // 1000 * 2^0
      expect(calculateBackoff(1, 1000, 30000, false)).toBe(2000); // 1000 * 2^1
      expect(calculateBackoff(2, 1000, 30000, false)).toBe(4000); // 1000 * 2^2
      expect(calculateBackoff(3, 1000, 30000, false)).toBe(8000); // 1000 * 2^3
      expect(calculateBackoff(4, 1000, 30000, false)).toBe(16000); // 1000 * 2^4
    });

    it("respects maxDelay ceiling", () => {
      expect(calculateBackoff(10, 1000, 30000, false)).toBe(30000);
      expect(calculateBackoff(5, 1000, 15000, false)).toBe(15000);
    });

    it("adds non-negative jitter within expected boundary", () => {
      const withJitter = calculateBackoff(1, 1000, 30000, true);
      expect(withJitter).toBeGreaterThanOrEqual(2000);
      expect(withJitter).toBeLessThanOrEqual(2250); // 1000 * 0.25 jitter max
    });
  });

  describe("classifyError (Permanent vs Transient)", () => {
    it("classifies 401/403 and JWT errors as permanent auth errors", () => {
      const res1 = classifyError({ status: 401, message: "Unauthorized request" });
      expect(res1.isPermanent).toBe(true);
      expect(res1.category).toBe("auth");

      const res2 = classifyError(new Error("jwt expired"));
      expect(res2.isPermanent).toBe(true);
      expect(res2.category).toBe("auth");
    });

    it("classifies 400/422 and validation errors as permanent validation errors", () => {
      const res = classifyError({ status: 400, message: "Validation failed: invalid payload" });
      expect(res.isPermanent).toBe(true);
      expect(res.category).toBe("validation");
    });

    it("classifies 409 conflict and already claimed errors as permanent conflict errors", () => {
      const res = classifyError({ status: 409, message: "Quest already claimed" });
      expect(res.isPermanent).toBe(true);
      expect(res.category).toBe("conflict");
    });

    it("classifies 404 as permanent not found", () => {
      const res = classifyError({ status: 404, message: "Course not found" });
      expect(res.isPermanent).toBe(true);
      expect(res.category).toBe("permanent");
    });

    it("classifies network disconnection and fetch failures as transient", () => {
      const res = classifyError(new Error("TypeError: Failed to fetch"));
      expect(res.isPermanent).toBe(false);
      expect(res.category).toBe("network");
    });

    it("classifies 5xx server errors and 429 rate limits as transient", () => {
      const serverErr = classifyError({ status: 503, message: "Service Unavailable" });
      expect(serverErr.isPermanent).toBe(false);
      expect(serverErr.category).toBe("transient");

      const rateErr = classifyError({ status: 429, message: "Too many requests" });
      expect(rateErr.isPermanent).toBe(false);
      expect(rateErr.category).toBe("transient");
    });
  });

  describe("enqueueMutation & Coalescing", () => {
    it("enqueues tasks into storage and reflects in stats", () => {
      const taskId = enqueueMutation({
        type: "test_action",
        payload: { value: 42 },
      });

      expect(taskId).toMatch(/^mut_/);
      const tasks = getQueueTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskId);
      expect(tasks[0].type).toBe("test_action");
      expect(tasks[0].payload).toEqual({ value: 42 });
      expect(tasks[0].status).toBe("pending");

      const stats = getQueueStats();
      expect(stats.total).toBe(1);
      expect(stats.pending).toBe(1);
    });

    it("returns a stable stats snapshot until the queue changes", () => {
      const first = getQueueStats();
      expect(getQueueStats()).toBe(first);

      enqueueMutation({ type: "test_action", payload: { value: 1 } });
      const next = getQueueStats();
      expect(next).not.toBe(first);
      expect(getQueueStats()).toBe(next);
    });

    it("coalesces tasks with the same dedupKey instead of creating duplicates", () => {
      const id1 = enqueueMutation({
        type: "sync_progress",
        payload: { step: 1 },
        dedupKey: "sync:user_1",
      });

      const id2 = enqueueMutation({
        type: "sync_progress",
        payload: { step: 2 },
        dedupKey: "sync:user_1",
      });

      expect(id2).toBe(id1);
      const tasks = getQueueTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].payload).toEqual({ step: 2 });
    });
  });

  describe("Dead-Letter Queue & Permanent vs Transient Processing", () => {
    it("immediately halts and marks permanent errors as failed (dead-letter) without wasting retries", async () => {
      const handler = vi.fn().mockRejectedValue({
        status: 401,
        message: "Unauthorized - token expired",
      });
      const unregister = registerMutationHandler("auth_fail", handler);

      const taskId = enqueueMutation({
        type: "auth_fail",
        payload: { action: "claim" },
        maxRetries: 5,
      });

      const res = await processQueue(true);
      expect(res.processed).toBe(0);
      expect(res.failed).toBe(1);

      const tasks = getQueueTasks();
      expect(tasks[0].status).toBe("failed");
      expect(tasks[0].attempts).toBe(1); // Only 1 attempt, no useless retries!
      expect(tasks[0].errorCategory).toBe("auth");
      expect(tasks[0].isPermanent).toBe(true);

      const deadLetter = getFailedMutations();
      expect(deadLetter).toHaveLength(1);
      expect(deadLetter[0].id).toBe(taskId);

      unregister();
    });

    it("retries transient network errors with backoff until maxRetries then transitions to dead-letter", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("Network timeout"));
      const unregister = registerMutationHandler("transient_fail", handler);

      enqueueMutation({
        type: "transient_fail",
        payload: {},
        maxRetries: 3,
        baseDelayMs: 200,
      });

      // Attempt 1 -> pending retry
      await processQueue(true);
      let tasks = getQueueTasks();
      expect(tasks[0].status).toBe("pending");
      expect(tasks[0].attempts).toBe(1);
      expect(tasks[0].errorCategory).toBe("network");

      // Attempt 2 -> pending retry
      await processQueue(true);
      tasks = getQueueTasks();
      expect(tasks[0].status).toBe("pending");
      expect(tasks[0].attempts).toBe(2);

      // Attempt 3 -> exceeded maxRetries -> dead-letter (failed)
      await processQueue(true);
      tasks = getQueueTasks();
      expect(tasks[0].status).toBe("failed");
      expect(tasks[0].attempts).toBe(3);

      const failedList = getFailedMutations();
      expect(failedList).toHaveLength(1);

      unregister();
    });

    it("manually retries an individual dead-letter task with retryMutation()", async () => {
      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw { status: 401, message: "Unauthorized" };
        return true;
      });

      const unregister = registerMutationHandler("single_retry", handler);

      const taskId = enqueueMutation({
        type: "single_retry",
        payload: {},
        maxRetries: 2,
      });

      // Attempt 1: fails permanently to dead-letter
      await processQueue(true);
      expect(getFailedMutations()).toHaveLength(1);

      // Manually retry this specific task
      const result = await retryMutation(taskId);
      expect(result.processed).toBe(1);

      const task = getQueueTasks().find((t) => t.id === taskId);
      expect(task?.status).toBe("completed");
      expect(getFailedMutations()).toHaveLength(0);

      unregister();
    });

    it("dismisses and deletes a dead-letter task with dismissMutation()", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("fatal"));
      const unregister = registerMutationHandler("dismiss_test", handler);

      const taskId = enqueueMutation({
        type: "dismiss_test",
        payload: {},
        maxRetries: 1,
      });

      await processQueue(true);
      expect(getFailedMutations()).toHaveLength(1);

      const dismissed = dismissMutation(taskId);
      expect(dismissed).toBe(true);
      expect(getFailedMutations()).toHaveLength(0);
      expect(getQueueTasks()).toHaveLength(0);

      unregister();
    });

    it("bulk retries all dead-letter tasks with retryFailedMutations()", async () => {
      let count = 0;
      const handler = vi.fn().mockImplementation(async () => {
        count++;
        if (count <= 2) throw new Error("Server error");
        return true;
      });

      const unregister = registerMutationHandler("bulk_retry", handler);

      enqueueMutation({ type: "bulk_retry", payload: { i: 1 }, maxRetries: 1 });
      enqueueMutation({ type: "bulk_retry", payload: { i: 2 }, maxRetries: 1 });

      await processQueue(true);
      expect(getFailedMutations()).toHaveLength(2);

      await retryFailedMutations();
      expect(getFailedMutations()).toHaveLength(0);

      const completed = getQueueTasks().filter((t) => t.status === "completed");
      expect(completed).toHaveLength(2);

      unregister();
    });
  });

  describe("Telemetry & Relative Time Formatting", () => {
    it("reports accurate lastAttemptAt and nextScheduledAttemptAt in getQueueStats()", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("transient"));
      const unregister = registerMutationHandler("telemetry_test", handler);

      const before = Date.now();
      enqueueMutation({
        type: "telemetry_test",
        payload: {},
        maxRetries: 3,
        baseDelayMs: 5000,
      });

      await processQueue(true);
      const stats = getQueueStats();

      expect(stats.lastAttemptAt).toBeGreaterThanOrEqual(before);
      expect(stats.nextScheduledAttemptAt).toBeGreaterThan(stats.lastAttemptAt!);
      expect(stats.pending).toBe(1);

      unregister();
    });

    it("formats relative timestamps in Arabic and English accurately", () => {
      const now = 1763164800000;

      // Past
      expect(formatTimeDifference(now - 3000, now, false, "ar")).toBe("الآن");
      expect(formatTimeDifference(now - 25000, now, false, "ar")).toBe("قبل 25 ثانية");
      expect(formatTimeDifference(now - 120000, now, false, "ar")).toBe("قبل 2 دقيقة");

      expect(formatTimeDifference(now - 3000, now, false, "en")).toBe("Just now");
      expect(formatTimeDifference(now - 25000, now, false, "en")).toBe("25s ago");
      expect(formatTimeDifference(now - 120000, now, false, "en")).toBe("2m ago");

      // Future countdown
      expect(formatTimeDifference(now + 15000, now, true, "ar")).toBe("خلال 15 ثانية");
      expect(formatTimeDifference(now + 15000, now, true, "en")).toBe("in 15s");
      expect(formatTimeDifference(now + 300000, now, true, "ar")).toBe("خلال 5 دقيقة");
      expect(formatTimeDifference(now + 300000, now, true, "en")).toBe("in 5m");

      // Null
      expect(formatTimeDifference(null, now, false, "ar")).toBe("لا يوجد");
      expect(formatTimeDifference(null, now, false, "en")).toBe("None");
    });
  });

  describe("Offline and Concurrency Hygiene", () => {
    it("halts processing when navigator is offline unless forced", async () => {
      const handler = vi.fn().mockResolvedValue(true);
      const unregister = registerMutationHandler("offline_check", handler);

      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
      });

      enqueueMutation({
        type: "offline_check",
        payload: {},
      });

      const res = await processQueue(false);
      expect(res.processed).toBe(0);
      expect(handler).not.toHaveBeenCalled();

      // Restore online
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: true,
      });

      await processQueue(false);
      expect(handler).toHaveBeenCalledTimes(1);

      unregister();
    });

    it("cancels pending mutations by id", () => {
      const id = enqueueMutation({
        type: "cancel_me",
        payload: { x: 10 },
      });

      expect(getQueueTasks()).toHaveLength(1);
      const ok = cancelMutation(id);
      expect(ok).toBe(true);
      expect(getQueueTasks()).toHaveLength(0);
      expect(getQueueStats().pending).toBe(0);
    });

    it("serializes concurrent processQueue calls without data corruption", async () => {
      let activeExecutions = 0;
      let maxConcurrent = 0;

      const handler = vi.fn().mockImplementation(async () => {
        activeExecutions++;
        maxConcurrent = Math.max(maxConcurrent, activeExecutions);
        await new Promise((r) => setTimeout(r, 20));
        activeExecutions--;
        return true;
      });

      const unregister = registerMutationHandler("concurrent_test", handler);

      enqueueMutation({ type: "concurrent_test", payload: { i: 1 } });
      enqueueMutation({ type: "concurrent_test", payload: { i: 2 } });

      const [res1, res2] = await Promise.all([
        processQueue(true),
        processQueue(true),
      ]);

      expect(maxConcurrent).toBe(1);
      expect(res1.processed + res2.processed).toBe(2);

      unregister();
    });
  });
});
