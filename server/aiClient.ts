import crypto from "crypto";
import {
  CF_COMPARE_ATTEMPT_TIMEOUT_MS,
  CF_COMPARE_NO_RAG_SYSTEM_INSTRUCTION,
  CF_COMPARE_RAG_SYSTEM_INSTRUCTION,
  CF_COMPARE_TOTAL_BUDGET_MS,
  checkCloudflareConnectivity,
  classifyCloudflareError,
  CloudflareConnectivityStatus,
  embedCloudflareQuery,
  formatCloudflareError,
  generateCloudflareEmbeddings,
  generateCloudflareRagAnswer,
  generateCloudflareWithoutRagAnswerDetailed,
  getCloudflareChatModel,
  getCloudflareEmbeddingModel,
  getCloudflareExpectedEmbeddingDimensions,
  isCloudflareConfigured,
} from "./cloudflareClient.js";
import { buildOptimizedRagPrompt, RagPromptOptions, redactSecrets, RetrievedChunkRef } from "./ragPrompt.js";

export type AiProvider = "cloudflare";

// Keep end-to-end execution cleanly within Vercel's 60s maxDuration across retrieval + inference.
export const VERCEL_REQUEST_DEADLINE_MS = 54_000;

export { CF_COMPARE_NO_RAG_SYSTEM_INSTRUCTION, CF_COMPARE_RAG_SYSTEM_INSTRUCTION };

export interface AiGenerationOptions {
  totalBudgetMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  deadlineMs?: number;
  requestId?: string;
  endpoint?: string;
  retrievalDurationMs?: number;
  maxTokens?: number;
  compactMaxTokens?: number;
  promptOptions?: RagPromptOptions;
  compactPromptOptions?: RagPromptOptions;
  systemInstruction?: string;
  promptTag?: string;
  signal?: AbortSignal;
}

export interface AiRagResult {
  answer: string;
  promptPreview: string;
  provider: AiProvider;
  model: string;
  finishReason: string | null;
  truncated: boolean;
}

export interface AiNoRagResult {
  answer: string;
  provider: AiProvider;
  model: string;
  finishReason: string | null;
  truncated: boolean;
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

export function getCompareAttemptTimeoutMs(): number {
  return CF_COMPARE_ATTEMPT_TIMEOUT_MS;
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
  options: { deadlineMs?: number; attemptTimeoutMs?: number; totalBudgetMs?: number; maxAttempts?: number; signal?: AbortSignal } = {}
): Promise<number[][]> {
  const model = getActiveEmbeddingModel();
  const vectors = await generateCloudflareEmbeddings(texts, options);
  return assertCloudflareVectorsValid(vectors, model);
}

export async function embedQuery(
  question: string,
  options: { deadlineMs?: number; attemptTimeoutMs?: number; totalBudgetMs?: number; signal?: AbortSignal } = {}
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
  const promptMetrics = buildOptimizedRagPrompt(question, chunks, options.promptOptions);
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

export async function generateWithoutRagAnswerWithMeta(
  question: string,
  options: AiGenerationOptions = {}
): Promise<AiNoRagResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const model = getCloudflareChatModel();
  const providerStart = Date.now();

  try {
    const completion = await generateCloudflareWithoutRagAnswerDetailed(question, options);
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
      answer: completion.answer,
      provider: "cloudflare",
      model,
      finishReason: completion.finishReason,
      truncated: completion.truncated,
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
