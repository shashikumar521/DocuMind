import crypto from "crypto";
import {
  CF_COMPARE_TOTAL_BUDGET_MS,
  classifyCloudflareError,
  embedCloudflareQuery,
  formatCloudflareError,
  generateCloudflareEmbeddings,
  generateCloudflareRagAnswer,
  generateCloudflareWithoutRagAnswer,
  getCloudflareChatModel,
  getCloudflareEmbeddingModel,
  getCloudflareExpectedEmbeddingDimensions,
  isCloudflareConfigured,
  isCloudflareErrorInstance,
} from "./cloudflareClient.js";
import {
  classifyGeminiError,
  embedQuery as embedGeminiQuery,
  formatGeminiError,
  GEMINI_COMPARE_TOTAL_BUDGET_MS,
  GEMINI_EMBEDDING_MODEL,
  generateEmbeddings as generateGeminiEmbeddings,
  generateRagAnswer as generateGeminiRagAnswer,
  generateWithoutRagAnswer as generateGeminiWithoutRagAnswer,
  getGeminiChatModel,
  isGeminiConfigured,
  RetrievedChunkRef,
} from "./geminiClient.js";
import { buildOptimizedRagPrompt, redactSecrets } from "./ragPrompt.js";

export type AiProvider = "gemini" | "cloudflare";

export const GEMINI_EMBEDDING_DIMENSIONS = 3072;

// Stay well inside Vercel's 60s maxDuration across retrieval + Gemini + Cloudflare fallback.
export const VERCEL_REQUEST_DEADLINE_MS = 52_000;

const GEMINI_FALLBACK_PRIMARY_ATTEMPT_TIMEOUT_MS = 11_000;
const GEMINI_FALLBACK_PRIMARY_TOTAL_BUDGET_MS = 15_000;
const GEMINI_FALLBACK_PRIMARY_MAX_ATTEMPTS = 2;
const CF_FALLBACK_RESERVED_MS = 18_000;
const CF_FALLBACK_ATTEMPT_TIMEOUT_MS = 15_000;
const CF_FALLBACK_TOTAL_BUDGET_MS = 24_000;

export interface AiGenerationOptions {
  totalBudgetMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  provider?: AiProvider;
  allowFallback?: boolean;
  deadlineMs?: number;
  requestId?: string;
  endpoint?: string;
  retrievalDurationMs?: number;
}

export interface AiRagResult {
  answer: string;
  promptPreview: string;
  provider: AiProvider;
  model: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export interface AiNoRagResult {
  answer: string;
  provider: AiProvider;
  model: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export interface AiTelemetryEvent {
  event: "ai_request";
  requestId: string;
  endpoint?: string;
  selectedProvider: AiProvider;
  fallbackProvider: AiProvider | null;
  model: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  retrievalDurationMs?: number;
  chunksCount?: number;
  contextChars?: number;
  promptChars?: number;
  providerDurationMs: number;
  httpStatus: number;
  timedOut: boolean;
  finalStatus: "success" | "fallback_success" | "error";
}

function emitAiTelemetry(payload: AiTelemetryEvent): void {
  const safePayload: AiTelemetryEvent = {
    ...payload,
    requestId: redactSecrets(payload.requestId),
    model: redactSecrets(payload.model),
    ...(payload.endpoint ? { endpoint: redactSecrets(payload.endpoint) } : {}),
    ...(payload.fallbackReason ? { fallbackReason: redactSecrets(payload.fallbackReason) } : {}),
  };
  const line = `[ai.telemetry] ${JSON.stringify(safePayload)}`;
  if (payload.finalStatus === "error") {
    console.error(line);
  } else if (payload.fallbackUsed) {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export class DualProviderFailureError extends Error {
  statusCode: number;
  primaryProvider: AiProvider;
  fallbackProvider: AiProvider;
  primaryStatus: number;
  fallbackStatus: number;

  constructor(params: {
    primaryProvider: AiProvider;
    fallbackProvider: AiProvider;
    primaryStatus: number;
    primaryMessage: string;
    fallbackStatus: number;
    fallbackMessage: string;
    statusCode: number;
  }) {
    super(
      redactSecrets(
        `Both primary AI (${params.primaryProvider}) and fallback AI (${params.fallbackProvider}) failed. Primary: ${params.primaryMessage} | Fallback: ${params.fallbackMessage}`
      )
    );
    this.name = "DualProviderFailureError";
    this.statusCode = params.statusCode;
    this.primaryProvider = params.primaryProvider;
    this.fallbackProvider = params.fallbackProvider;
    this.primaryStatus = params.primaryStatus;
    this.fallbackStatus = params.fallbackStatus;
  }
}

export function getActiveAiProvider(): AiProvider {
  const configured = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (configured === "cloudflare") {
    return "cloudflare";
  }
  return "gemini";
}

export function getActiveChatModel(provider: AiProvider = getActiveAiProvider()): string {
  return provider === "cloudflare" ? getCloudflareChatModel() : getGeminiChatModel();
}

export function getActiveEmbeddingModel(provider: AiProvider = getActiveAiProvider()): string {
  return provider === "cloudflare" ? getCloudflareEmbeddingModel() : GEMINI_EMBEDDING_MODEL;
}

export function getExpectedEmbeddingDimensions(
  provider: AiProvider = getActiveAiProvider()
): number {
  return provider === "cloudflare"
    ? getCloudflareExpectedEmbeddingDimensions()
    : GEMINI_EMBEDDING_DIMENSIONS;
}

export function isAiConfigured(provider: AiProvider = getActiveAiProvider()): boolean {
  return provider === "cloudflare" ? isCloudflareConfigured() : isGeminiConfigured();
}

export function isCloudflareFallbackAvailable(): boolean {
  return isCloudflareConfigured();
}

export function getCompareTotalBudgetMs(provider: AiProvider = getActiveAiProvider()): number {
  return provider === "cloudflare"
    ? CF_COMPARE_TOTAL_BUDGET_MS
    : GEMINI_COMPARE_TOTAL_BUDGET_MS;
}

export function isFallbackEligibleGeminiError(err: unknown): {
  eligible: boolean;
  reason: string;
  status: number;
} {
  const classified = classifyGeminiError(err);
  const status = classified.statusCode ?? 500;
  const eligible =
    classified.kind === "rate_limit" ||
    classified.kind === "quota_exhausted" ||
    classified.kind === "transient" ||
    classified.kind === "timeout" ||
    classified.kind === "config";
  return {
    eligible,
    reason: classified.kind,
    status,
  };
}

function buildGeminiPrimaryOptions(
  options: AiGenerationOptions,
  fallbackReady: boolean
): {
  totalBudgetMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  deadlineMs?: number;
} {
  if (!fallbackReady) {
    return {
      totalBudgetMs: options.totalBudgetMs,
      attemptTimeoutMs: options.attemptTimeoutMs,
      maxAttempts: options.maxAttempts,
      deadlineMs: options.deadlineMs,
    };
  }

  if (options.deadlineMs !== undefined) {
    const remainingMs = Math.max(0, options.deadlineMs - Date.now());
    const reservedMaxBudget =
      remainingMs > CF_FALLBACK_RESERVED_MS + 4_000
        ? Math.min(GEMINI_FALLBACK_PRIMARY_TOTAL_BUDGET_MS, remainingMs - CF_FALLBACK_RESERVED_MS)
        : Math.min(GEMINI_FALLBACK_PRIMARY_TOTAL_BUDGET_MS, Math.max(100, Math.floor(remainingMs * 0.45)));
    const totalBudgetMs =
      options.totalBudgetMs !== undefined
        ? Math.min(options.totalBudgetMs, reservedMaxBudget)
        : reservedMaxBudget;
    const attemptTimeoutMs =
      options.attemptTimeoutMs !== undefined
        ? Math.min(options.attemptTimeoutMs, totalBudgetMs)
        : Math.min(GEMINI_FALLBACK_PRIMARY_ATTEMPT_TIMEOUT_MS, totalBudgetMs);
    return {
      totalBudgetMs,
      attemptTimeoutMs,
      maxAttempts: options.maxAttempts ?? GEMINI_FALLBACK_PRIMARY_MAX_ATTEMPTS,
      deadlineMs: Math.min(options.deadlineMs, Date.now() + totalBudgetMs),
    };
  }

  const totalBudgetMs =
    options.totalBudgetMs !== undefined
      ? Math.min(options.totalBudgetMs, GEMINI_FALLBACK_PRIMARY_TOTAL_BUDGET_MS)
      : GEMINI_FALLBACK_PRIMARY_TOTAL_BUDGET_MS;
  return {
    totalBudgetMs,
    attemptTimeoutMs:
      options.attemptTimeoutMs !== undefined
        ? Math.min(options.attemptTimeoutMs, GEMINI_FALLBACK_PRIMARY_ATTEMPT_TIMEOUT_MS)
        : GEMINI_FALLBACK_PRIMARY_ATTEMPT_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? GEMINI_FALLBACK_PRIMARY_MAX_ATTEMPTS,
  };
}

function buildCloudflareFallbackOptions(options: AiGenerationOptions): {
  totalBudgetMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  deadlineMs?: number;
} {
  const totalBudgetMs = options.totalBudgetMs ?? CF_FALLBACK_TOTAL_BUDGET_MS;
  return {
    totalBudgetMs,
    attemptTimeoutMs:
      options.attemptTimeoutMs !== undefined
        ? Math.min(options.attemptTimeoutMs, CF_FALLBACK_ATTEMPT_TIMEOUT_MS)
        : CF_FALLBACK_ATTEMPT_TIMEOUT_MS,
    maxAttempts: options.maxAttempts,
    deadlineMs: options.deadlineMs,
  };
}

function assertProviderVectorsValid(
  vectors: number[][],
  provider: AiProvider,
  model: string
): number[][] {
  const expectedDims = getExpectedEmbeddingDimensions(provider);
  for (const vec of vectors) {
    if (!Array.isArray(vec) || vec.length !== expectedDims) {
      throw new Error(
        `Embedding dimension mismatch for ${provider} (${model}): expected ${expectedDims}, received ${Array.isArray(vec) ? vec.length : 0}.`
      );
    }
  }
  return vectors;
}

export async function generateEmbeddings(
  texts: string[],
  provider: AiProvider = getActiveAiProvider(),
  options: { deadlineMs?: number; attemptTimeoutMs?: number; totalBudgetMs?: number; maxAttempts?: number } = {}
): Promise<number[][]> {
  const model = getActiveEmbeddingModel(provider);
  const vectors =
    provider === "cloudflare"
      ? await generateCloudflareEmbeddings(texts, options)
      : await generateGeminiEmbeddings(texts, options);
  return assertProviderVectorsValid(vectors, provider, model);
}

export async function embedQuery(
  question: string,
  provider: AiProvider = getActiveAiProvider(),
  options: { deadlineMs?: number; attemptTimeoutMs?: number; totalBudgetMs?: number } = {}
): Promise<number[]> {
  const model = getActiveEmbeddingModel(provider);
  const vector =
    provider === "cloudflare"
      ? await embedCloudflareQuery(question, options)
      : await embedGeminiQuery(question, options);
  assertProviderVectorsValid([vector], provider, model);
  return vector;
}

export async function generateRagAnswer(
  question: string,
  chunks: RetrievedChunkRef[],
  options: AiGenerationOptions = {}
): Promise<AiRagResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const primaryProvider = options.provider ?? getActiveAiProvider();
  const promptMetrics = buildOptimizedRagPrompt(question, chunks);
  const providerStart = Date.now();

  if (primaryProvider === "cloudflare") {
    const model = getCloudflareChatModel();
    try {
      const res = await generateCloudflareRagAnswer(question, chunks, options);
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "cloudflare",
        fallbackProvider: null,
        model,
        fallbackUsed: false,
        retrievalDurationMs: options.retrievalDurationMs,
        chunksCount: chunks.length,
        contextChars: promptMetrics.contextChars,
        promptChars: res.promptPreview.length,
        providerDurationMs: Date.now() - providerStart,
        httpStatus: 200,
        timedOut: false,
        finalStatus: "success",
      });
      return {
        ...res,
        provider: "cloudflare",
        model,
        fallbackUsed: false,
      };
    } catch (err: unknown) {
      const classified = classifyCloudflareError(err);
      const formatted = formatCloudflareError(err);
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "cloudflare",
        fallbackProvider: null,
        model,
        fallbackUsed: false,
        retrievalDurationMs: options.retrievalDurationMs,
        chunksCount: chunks.length,
        contextChars: promptMetrics.contextChars,
        promptChars: promptMetrics.promptPreview.length,
        providerDurationMs: Date.now() - providerStart,
        httpStatus: formatted.status,
        timedOut: classified.kind === "timeout",
        finalStatus: "error",
      });
      throw err;
    }
  }

  const allowFallback = options.allowFallback !== false;
  const fallbackReady = allowFallback && isCloudflareFallbackAvailable();
  const geminiModel = getGeminiChatModel();

  try {
    const res = await generateGeminiRagAnswer(
      question,
      chunks,
      buildGeminiPrimaryOptions(options, fallbackReady)
    );
    emitAiTelemetry({
      event: "ai_request",
      requestId,
      endpoint: options.endpoint,
      selectedProvider: "gemini",
      fallbackProvider: fallbackReady ? "cloudflare" : null,
      model: geminiModel,
      fallbackUsed: false,
      retrievalDurationMs: options.retrievalDurationMs,
      chunksCount: chunks.length,
      contextChars: promptMetrics.contextChars,
      promptChars: res.promptPreview.length,
      providerDurationMs: Date.now() - providerStart,
      httpStatus: 200,
      timedOut: false,
      finalStatus: "success",
    });
    return {
      ...res,
      provider: "gemini",
      model: geminiModel,
      fallbackUsed: false,
    };
  } catch (primaryErr: unknown) {
    const check = isFallbackEligibleGeminiError(primaryErr);
    if (!fallbackReady || !check.eligible) {
      const primaryFormatted = formatGeminiError(primaryErr);
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "gemini",
        fallbackProvider: fallbackReady ? "cloudflare" : null,
        model: geminiModel,
        fallbackUsed: false,
        retrievalDurationMs: options.retrievalDurationMs,
        chunksCount: chunks.length,
        contextChars: promptMetrics.contextChars,
        promptChars: promptMetrics.promptPreview.length,
        providerDurationMs: Date.now() - providerStart,
        httpStatus: primaryFormatted.status,
        timedOut: check.reason === "timeout",
        finalStatus: "error",
      });
      throw primaryErr;
    }

    const cfModel = getCloudflareChatModel();
    const cfStart = Date.now();
    try {
      const remainingBeforeCf =
        options.deadlineMs !== undefined ? options.deadlineMs - Date.now() : undefined;
      if (remainingBeforeCf !== undefined && remainingBeforeCf <= 80) {
        const deadlineErr = new Error(
          "Cloudflare Workers AI request timed out (shared request deadline reached)."
        );
        deadlineErr.name = "AbortError";
        throw deadlineErr;
      }

      const cfRes = await generateCloudflareRagAnswer(
        question,
        chunks,
        buildCloudflareFallbackOptions(options)
      );
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "cloudflare",
        fallbackProvider: "cloudflare",
        model: cfModel,
        fallbackUsed: true,
        fallbackReason: check.reason,
        retrievalDurationMs: options.retrievalDurationMs,
        chunksCount: chunks.length,
        contextChars: promptMetrics.contextChars,
        promptChars: cfRes.promptPreview.length,
        providerDurationMs: Date.now() - cfStart,
        httpStatus: 200,
        timedOut: false,
        finalStatus: "fallback_success",
      });
      return {
        ...cfRes,
        provider: "cloudflare",
        model: cfModel,
        fallbackUsed: true,
        fallbackReason: check.reason,
      };
    } catch (fallbackErr: unknown) {
      const primaryFormatted = formatGeminiError(primaryErr);
      const fallbackFormatted = formatCloudflareError(fallbackErr);
      const cfClassified = classifyCloudflareError(fallbackErr);
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "cloudflare",
        fallbackProvider: "cloudflare",
        model: cfModel,
        fallbackUsed: true,
        fallbackReason: check.reason,
        retrievalDurationMs: options.retrievalDurationMs,
        chunksCount: chunks.length,
        contextChars: promptMetrics.contextChars,
        promptChars: promptMetrics.promptPreview.length,
        providerDurationMs: Date.now() - providerStart,
        httpStatus: fallbackFormatted.status,
        timedOut: check.reason === "timeout" || cfClassified.kind === "timeout",
        finalStatus: "error",
      });
      throw new DualProviderFailureError({
        primaryProvider: "gemini",
        fallbackProvider: "cloudflare",
        primaryStatus: primaryFormatted.status,
        primaryMessage: primaryFormatted.message,
        fallbackStatus: fallbackFormatted.status,
        fallbackMessage: fallbackFormatted.message,
        statusCode: fallbackFormatted.status >= 400 ? fallbackFormatted.status : 503,
      });
    }
  }
}

export async function generateWithoutRagAnswerWithMeta(
  question: string,
  options: AiGenerationOptions = {}
): Promise<AiNoRagResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const primaryProvider = options.provider ?? getActiveAiProvider();
  const providerStart = Date.now();

  if (primaryProvider === "cloudflare") {
    const model = getCloudflareChatModel();
    try {
      const answer = await generateCloudflareWithoutRagAnswer(question, options);
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "cloudflare",
        fallbackProvider: null,
        model,
        fallbackUsed: false,
        promptChars: question.length,
        providerDurationMs: Date.now() - providerStart,
        httpStatus: 200,
        timedOut: false,
        finalStatus: "success",
      });
      return {
        answer,
        provider: "cloudflare",
        model,
        fallbackUsed: false,
      };
    } catch (err: unknown) {
      const formatted = formatCloudflareError(err);
      const classified = classifyCloudflareError(err);
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "cloudflare",
        fallbackProvider: null,
        model,
        fallbackUsed: false,
        promptChars: question.length,
        providerDurationMs: Date.now() - providerStart,
        httpStatus: formatted.status,
        timedOut: classified.kind === "timeout",
        finalStatus: "error",
      });
      throw err;
    }
  }

  const allowFallback = options.allowFallback !== false;
  const fallbackReady = allowFallback && isCloudflareFallbackAvailable();
  const geminiModel = getGeminiChatModel();

  try {
    const answer = await generateGeminiWithoutRagAnswer(
      question,
      buildGeminiPrimaryOptions(options, fallbackReady)
    );
    emitAiTelemetry({
      event: "ai_request",
      requestId,
      endpoint: options.endpoint,
      selectedProvider: "gemini",
      fallbackProvider: fallbackReady ? "cloudflare" : null,
      model: geminiModel,
      fallbackUsed: false,
      promptChars: question.length,
      providerDurationMs: Date.now() - providerStart,
      httpStatus: 200,
      timedOut: false,
      finalStatus: "success",
    });
    return {
      answer,
      provider: "gemini",
      model: geminiModel,
      fallbackUsed: false,
    };
  } catch (primaryErr: unknown) {
    const check = isFallbackEligibleGeminiError(primaryErr);
    if (!fallbackReady || !check.eligible) {
      const primaryFormatted = formatGeminiError(primaryErr);
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "gemini",
        fallbackProvider: fallbackReady ? "cloudflare" : null,
        model: geminiModel,
        fallbackUsed: false,
        promptChars: question.length,
        providerDurationMs: Date.now() - providerStart,
        httpStatus: primaryFormatted.status,
        timedOut: check.reason === "timeout",
        finalStatus: "error",
      });
      throw primaryErr;
    }

    const cfModel = getCloudflareChatModel();
    const cfStart = Date.now();
    try {
      const remainingBeforeCf =
        options.deadlineMs !== undefined ? options.deadlineMs - Date.now() : undefined;
      if (remainingBeforeCf !== undefined && remainingBeforeCf <= 80) {
        const deadlineErr = new Error(
          "Cloudflare Workers AI request timed out (shared request deadline reached)."
        );
        deadlineErr.name = "AbortError";
        throw deadlineErr;
      }

      const answer = await generateCloudflareWithoutRagAnswer(
        question,
        buildCloudflareFallbackOptions(options)
      );
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "cloudflare",
        fallbackProvider: "cloudflare",
        model: cfModel,
        fallbackUsed: true,
        fallbackReason: check.reason,
        promptChars: question.length,
        providerDurationMs: Date.now() - cfStart,
        httpStatus: 200,
        timedOut: false,
        finalStatus: "fallback_success",
      });
      return {
        answer,
        provider: "cloudflare",
        model: cfModel,
        fallbackUsed: true,
        fallbackReason: check.reason,
      };
    } catch (fallbackErr: unknown) {
      const primaryFormatted = formatGeminiError(primaryErr);
      const fallbackFormatted = formatCloudflareError(fallbackErr);
      const cfClassified = classifyCloudflareError(fallbackErr);
      emitAiTelemetry({
        event: "ai_request",
        requestId,
        endpoint: options.endpoint,
        selectedProvider: "cloudflare",
        fallbackProvider: "cloudflare",
        model: cfModel,
        fallbackUsed: true,
        fallbackReason: check.reason,
        promptChars: question.length,
        providerDurationMs: Date.now() - providerStart,
        httpStatus: fallbackFormatted.status,
        timedOut: check.reason === "timeout" || cfClassified.kind === "timeout",
        finalStatus: "error",
      });
      throw new DualProviderFailureError({
        primaryProvider: "gemini",
        fallbackProvider: "cloudflare",
        primaryStatus: primaryFormatted.status,
        primaryMessage: primaryFormatted.message,
        fallbackStatus: fallbackFormatted.status,
        fallbackMessage: fallbackFormatted.message,
        statusCode: fallbackFormatted.status >= 400 ? fallbackFormatted.status : 503,
      });
    }
  }
}

export async function generateWithoutRagAnswer(
  question: string,
  options: AiGenerationOptions = {}
): Promise<string> {
  const result = await generateWithoutRagAnswerWithMeta(question, options);
  return result.answer;
}

export function formatAiError(
  err: unknown,
  provider: AiProvider = getActiveAiProvider()
): { status: number; message: string } {
  if (err instanceof DualProviderFailureError) {
    return { status: err.statusCode, message: redactSecrets(err.message) };
  }
  if (isCloudflareErrorInstance(err)) {
    return formatCloudflareError(err);
  }
  if (isGeminiErrorInstance(err)) {
    return formatGeminiError(err);
  }
  if (provider === "cloudflare") {
    return formatCloudflareError(err);
  }
  return formatGeminiError(err);
}

function isGeminiErrorInstance(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "GeminiConfigError" ||
    err.name === "GeminiRateLimitError" ||
    err.name === "GeminiQuotaExhaustedError"
  );
}

export type { RetrievedChunkRef };
