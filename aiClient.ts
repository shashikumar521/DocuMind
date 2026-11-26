import crypto from "crypto";
import {
  CF_COMPARE_TOTAL_BUDGET_MS,
  checkCloudflareConnectivity,
  classifyCloudflareError,
  CloudflareConnectivityStatus,
  embedCloudflareQuery,
  formatCloudflareError,
  generateCloudflareDocumentComparison,
  generateCloudflareEmbeddings,
  generateCloudflareRagAnswer,
  generateCloudflareWithoutRagAnswer,
  getCloudflareChatModel,
  getCloudflareEmbeddingModel,
  getCloudflareExpectedEmbeddingDimensions,
  isCloudflareConfigured,
} from "./cloudflareClient.js";
import {
  buildOptimizedRagPrompt,
  DOC_COMPARE_MAX_CONTEXT_CHARS,
  OptimizedPromptResult,
  redactSecrets,
  RetrievedChunkRef,
} from "./ragPrompt.js";

export type AiProvider = "cloudflare";

// Keep end-to-end execution cleanly within Vercel's 60s maxDuration across retrieval + inference.
export const VERCEL_REQUEST_DEADLINE_MS = 52_000;

export interface AiGenerationOptions {
  totalBudgetMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
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
}

export interface AiNoRagResult {
  answer: string;
  provider: AiProvider;
  model: string;
}

export interface AiTelemetryEvent {
  event: "ai_request";
  requestId: string;
  endpoint?: string;
  provider: AiProvider;
  model: string;
  retrievalDurationMs?: number;
  chunksCount?: number;
  contextChars?: number;
  promptChars?: number;
  providerDurationMs: number;
  httpStatus: number;
  timedOut: boolean;
  finalStatus: "success" | "error";
}

function emitAiTelemetry(payload: AiTelemetryEvent): void {
  const safePayload: AiTelemetryEvent = {
    ...payload,
    requestId: redactSecrets(payload.requestId),
    model: redactSecrets(payload.model),
    ...(payload.endpoint ? { endpoint: redactSecrets(payload.endpoint) } : {}),
  };
  const line = `[ai.telemetry] ${JSON.stringify(safePayload)}`;
  if (payload.finalStatus === "error") {
    console.error(line);
  } else {
    console.info(line);
  }
}

export function getActiveAiProvider(): AiProvider {
  return "cloudflare";
}

export function getActiveChatModel(): string {
  return getCloudflareChatModel();
}

export function getActiveEmbeddingModel(): string {
  return getCloudflareEmbeddingModel();
}

export function getExpectedEmbeddingDimensions(): number {
  return getCloudflareExpectedEmbeddingDimensions();
}

export function isAiConfigured(): boolean {
  return isCloudflareConfigured();
}

export async function checkAiProviderConnectivity(
  options: { timeoutMs?: number; forceRefresh?: boolean } = {}
): Promise<CloudflareConnectivityStatus> {
  return checkCloudflareConnectivity(options);
}

export function getCompareTotalBudgetMs(): number {
  return CF_COMPARE_TOTAL_BUDGET_MS;
}

function assertCloudflareVectorsValid(vectors: number[][], model: string): number[][] {
  const expectedDims = getExpectedEmbeddingDimensions();
  for (const vec of vectors) {
    if (!Array.isArray(vec) || vec.length !== expectedDims) {
      throw new Error(
        `Embedding dimension mismatch for cloudflare (${model}): expected ${expectedDims}, received ${Array.isArray(vec) ? vec.length : 0}.`
      );
    }
  }
  return vectors;
}

export async function generateEmbeddings(
  texts: string[],
  options: { deadlineMs?: number; attemptTimeoutMs?: number; totalBudgetMs?: number; maxAttempts?: number } = {}
): Promise<number[][]> {
  const model = getActiveEmbeddingModel();
  const vectors = await generateCloudflareEmbeddings(texts, options);
  return assertCloudflareVectorsValid(vectors, model);
}

export async function embedQuery(
  question: string,
  options: { deadlineMs?: number; attemptTimeoutMs?: number; totalBudgetMs?: number } = {}
): Promise<number[]> {
  const model = getActiveEmbeddingModel();
  const vector = await embedCloudflareQuery(question, options);
  assertCloudflareVectorsValid([vector], model);
  return vector;
}

export async function generateRagAnswer(
  question: string,
  chunks: RetrievedChunkRef[],
  options: AiGenerationOptions = {}
): Promise<AiRagResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const model = getCloudflareChatModel();
  const promptMetrics = buildOptimizedRagPrompt(question, chunks);
  const providerStart = Date.now();

  try {
    const res = await generateCloudflareRagAnswer(question, chunks, options);
    emitAiTelemetry({
      event: "ai_request",
      requestId,
      endpoint: options.endpoint,
      provider: "cloudflare",
      model,
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
    };
  } catch (err: unknown) {
    const classified = classifyCloudflareError(err);
    const formatted = formatCloudflareError(err);
    emitAiTelemetry({
      event: "ai_request",
      requestId,
      endpoint: options.endpoint,
      provider: "cloudflare",
      model,
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

export interface AiDocumentCompareResult {
  comparison: string;
  promptPreview: string;
  provider: AiProvider;
  model: string;
  contextStats: {
    originalChunks: number;
    optimizedChunks: number;
    contextChars: number;
    maxContextChars: number;
  };
  optimized: OptimizedPromptResult;
}

export async function generateDocumentComparison(
  params: {
    question?: string;
    documents: Array<{ id: string; filename: string; pages: number }>;
    chunksByDocument: Map<string, RetrievedChunkRef[]>;
  },
  options: AiGenerationOptions = {}
): Promise<AiDocumentCompareResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const model = getCloudflareChatModel();
  const providerStart = Date.now();
  let totalChunks = 0;
  for (const list of params.chunksByDocument.values()) {
    totalChunks += list.length;
  }

  try {
    const res = await generateCloudflareDocumentComparison(params, options);
    emitAiTelemetry({
      event: "ai_request",
      requestId,
      endpoint: options.endpoint ?? "/api/documents/compare",
      provider: "cloudflare",
      model,
      retrievalDurationMs: options.retrievalDurationMs,
      chunksCount: totalChunks,
      contextChars: res.optimized.contextChars,
      promptChars: res.promptPreview.length,
      providerDurationMs: Date.now() - providerStart,
      httpStatus: 200,
      timedOut: false,
      finalStatus: "success",
    });
    return {
      comparison: res.answer,
      promptPreview: res.promptPreview,
      provider: "cloudflare",
      model,
      contextStats: {
        originalChunks: res.optimized.originalChunksCount,
        optimizedChunks: res.optimized.deduplicatedChunksCount,
        contextChars: res.optimized.contextChars,
        maxContextChars: DOC_COMPARE_MAX_CONTEXT_CHARS,
      },
      optimized: res.optimized,
    };
  } catch (err: unknown) {
    const classified = classifyCloudflareError(err);
    const formatted = formatCloudflareError(err);
    emitAiTelemetry({
      event: "ai_request",
      requestId,
      endpoint: options.endpoint ?? "/api/documents/compare",
      provider: "cloudflare",
      model,
      retrievalDurationMs: options.retrievalDurationMs,
      chunksCount: totalChunks,
      providerDurationMs: Date.now() - providerStart,
      httpStatus: formatted.status,
      timedOut: classified.kind === "timeout",
      finalStatus: "error",
    });
    throw err;
  }
}

export async function generateWithoutRagAnswerWithMeta(
  question: string,
  options: AiGenerationOptions = {}
): Promise<AiNoRagResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const model = getCloudflareChatModel();
  const providerStart = Date.now();

  try {
    const answer = await generateCloudflareWithoutRagAnswer(question, options);
    emitAiTelemetry({
      event: "ai_request",
      requestId,
      endpoint: options.endpoint,
      provider: "cloudflare",
      model,
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
    };
  } catch (err: unknown) {
    const formatted = formatCloudflareError(err);
    const classified = classifyCloudflareError(err);
    emitAiTelemetry({
      event: "ai_request",
      requestId,
      endpoint: options.endpoint,
      provider: "cloudflare",
      model,
      promptChars: question.length,
      providerDurationMs: Date.now() - providerStart,
      httpStatus: formatted.status,
      timedOut: classified.kind === "timeout",
      finalStatus: "error",
    });
    throw err;
  }
}

export async function generateWithoutRagAnswer(
  question: string,
  options: AiGenerationOptions = {}
): Promise<string> {
  const result = await generateWithoutRagAnswerWithMeta(question, options);
  return result.answer;
}

export function formatAiError(err: unknown): { status: number; message: string } {
  const formatted = formatCloudflareError(err);
  return {
    status: formatted.status,
    message: redactSecrets(formatted.message),
  };
}

export type { CloudflareConnectivityStatus, RetrievedChunkRef };
