import {
  CF_COMPARE_TOTAL_BUDGET_MS,
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

export type AiProvider = "gemini" | "cloudflare";

export const GEMINI_EMBEDDING_DIMENSIONS = 3072;

// Keep primary Gemini attempt+retry bounded when Cloudflare fallback is ready
// so the combined request fits well inside Vercel's 60s maxDuration.
const GEMINI_FALLBACK_PRIMARY_ATTEMPT_TIMEOUT_MS = 12_000;
const GEMINI_FALLBACK_PRIMARY_TOTAL_BUDGET_MS = 18_000;
const GEMINI_FALLBACK_PRIMARY_MAX_ATTEMPTS = 2;
const CF_FALLBACK_TOTAL_BUDGET_MS = 25_000;

export interface AiGenerationOptions {
  totalBudgetMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  provider?: AiProvider;
  allowFallback?: boolean;
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
      `Both primary AI (${params.primaryProvider}) and fallback AI (${params.fallbackProvider}) failed. Primary: ${params.primaryMessage} | Fallback: ${params.fallbackMessage}`
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
): { totalBudgetMs?: number; attemptTimeoutMs?: number; maxAttempts?: number } {
  if (!fallbackReady) {
    return {
      totalBudgetMs: options.totalBudgetMs,
      attemptTimeoutMs: options.attemptTimeoutMs,
      maxAttempts: options.maxAttempts,
    };
  }
  return {
    totalBudgetMs:
      options.totalBudgetMs !== undefined
        ? Math.min(options.totalBudgetMs, GEMINI_FALLBACK_PRIMARY_TOTAL_BUDGET_MS)
        : GEMINI_FALLBACK_PRIMARY_TOTAL_BUDGET_MS,
    attemptTimeoutMs:
      options.attemptTimeoutMs !== undefined
        ? Math.min(options.attemptTimeoutMs, GEMINI_FALLBACK_PRIMARY_ATTEMPT_TIMEOUT_MS)
        : GEMINI_FALLBACK_PRIMARY_ATTEMPT_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? GEMINI_FALLBACK_PRIMARY_MAX_ATTEMPTS,
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
  provider: AiProvider = getActiveAiProvider()
): Promise<number[][]> {
  const model = getActiveEmbeddingModel(provider);
  const vectors =
    provider === "cloudflare"
      ? await generateCloudflareEmbeddings(texts)
      : await generateGeminiEmbeddings(texts);
  return assertProviderVectorsValid(vectors, provider, model);
}

export async function embedQuery(
  question: string,
  provider: AiProvider = getActiveAiProvider()
): Promise<number[]> {
  const model = getActiveEmbeddingModel(provider);
  const vector =
    provider === "cloudflare"
      ? await embedCloudflareQuery(question)
      : await embedGeminiQuery(question);
  assertProviderVectorsValid([vector], provider, model);
  return vector;
}

export async function generateRagAnswer(
  question: string,
  chunks: RetrievedChunkRef[],
  options: AiGenerationOptions = {}
): Promise<AiRagResult> {
  const primaryProvider = options.provider ?? getActiveAiProvider();

  if (primaryProvider === "cloudflare") {
    const model = getCloudflareChatModel();
    const res = await generateCloudflareRagAnswer(question, chunks, options);
    console.info(
      `[ai] Handled RAG request with provider=cloudflare model=${model} chunks=${chunks.length}`
    );
    return {
      ...res,
      provider: "cloudflare",
      model,
      fallbackUsed: false,
    };
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
    console.info(
      `[ai] Handled RAG request with provider=gemini model=${geminiModel} chunks=${chunks.length}`
    );
    return {
      ...res,
      provider: "gemini",
      model: geminiModel,
      fallbackUsed: false,
    };
  } catch (primaryErr: unknown) {
    const check = isFallbackEligibleGeminiError(primaryErr);
    if (!fallbackReady || !check.eligible) {
      throw primaryErr;
    }

    const cfModel = getCloudflareChatModel();
    console.warn(
      `[ai] Primary provider=gemini model=${geminiModel} failed (reason=${check.reason}, status=${check.status}); falling back to provider=cloudflare model=${cfModel} for RAG request (chunks=${chunks.length}).`
    );

    try {
      const cfRes = await generateCloudflareRagAnswer(question, chunks, {
        totalBudgetMs: options.totalBudgetMs ?? CF_FALLBACK_TOTAL_BUDGET_MS,
        attemptTimeoutMs: options.attemptTimeoutMs,
        maxAttempts: options.maxAttempts,
      });
      console.info(
        `[ai] Handled RAG request via fallback provider=cloudflare model=${cfModel} (fallback_from=gemini, reason=${check.reason}, chunks=${chunks.length}).`
      );
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
      console.error(
        `[ai] Dual-provider RAG failure: primary=gemini (status=${primaryFormatted.status}) and fallback=cloudflare (status=${fallbackFormatted.status}).`
      );
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
  const primaryProvider = options.provider ?? getActiveAiProvider();

  if (primaryProvider === "cloudflare") {
    const model = getCloudflareChatModel();
    const answer = await generateCloudflareWithoutRagAnswer(question, options);
    console.info(
      `[ai] Handled non-RAG request with provider=cloudflare model=${model}`
    );
    return {
      answer,
      provider: "cloudflare",
      model,
      fallbackUsed: false,
    };
  }

  const allowFallback = options.allowFallback !== false;
  const fallbackReady = allowFallback && isCloudflareFallbackAvailable();
  const geminiModel = getGeminiChatModel();

  try {
    const answer = await generateGeminiWithoutRagAnswer(
      question,
      buildGeminiPrimaryOptions(options, fallbackReady)
    );
    console.info(
      `[ai] Handled non-RAG request with provider=gemini model=${geminiModel}`
    );
    return {
      answer,
      provider: "gemini",
      model: geminiModel,
      fallbackUsed: false,
    };
  } catch (primaryErr: unknown) {
    const check = isFallbackEligibleGeminiError(primaryErr);
    if (!fallbackReady || !check.eligible) {
      throw primaryErr;
    }

    const cfModel = getCloudflareChatModel();
    console.warn(
      `[ai] Primary provider=gemini model=${geminiModel} failed (reason=${check.reason}, status=${check.status}); falling back to provider=cloudflare model=${cfModel} for non-RAG request.`
    );

    try {
      const answer = await generateCloudflareWithoutRagAnswer(question, {
        totalBudgetMs: options.totalBudgetMs ?? CF_FALLBACK_TOTAL_BUDGET_MS,
        attemptTimeoutMs: options.attemptTimeoutMs,
        maxAttempts: options.maxAttempts,
      });
      console.info(
        `[ai] Handled non-RAG request via fallback provider=cloudflare model=${cfModel} (fallback_from=gemini, reason=${check.reason}).`
      );
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
      console.error(
        `[ai] Dual-provider non-RAG failure: primary=gemini (status=${primaryFormatted.status}) and fallback=cloudflare (status=${fallbackFormatted.status}).`
      );
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
    return { status: err.statusCode, message: err.message };
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
