import { detectFormat, getTargetFormat } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { COLORS } from "../utils/stream.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelStrip, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { injectCaveman } from "../rtk/caveman.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { runCompressionPipeline, formatPipelineLog } from "../rtk/pipeline.js";
import { recordTokenLimitFailure, isTokenLimitError, getAdaptiveMaxTokens } from "../config/adaptiveTokenStore.js";
import { adjustMaxTokens } from "../translator/helpers/maxTokensHelper.js";
import { DEFAULT_MAX_TOKENS } from "../config/runtimeConfig.js";
import { compactContext } from "../compactor/contextCompactor.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, cavemanEnabled, cavemanLevel, inputCavemanEnabled, sourceFormatOverride, providerThinking }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const targetFormat = modelTargetFormat || getTargetFormat(provider);
  const stripList = getModelStrip(alias, model);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = provider === "openai" || provider === "codex" || provider === "commandcode";
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  let translatedBody;
  let toolNameMap;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model };
  } else {
    translatedBody = translateRequest(sourceFormat, targetFormat, model, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    if (!translatedBody) {
  // Apply universal max_tokens adjustment
  translatedBody.max_tokens = adjustMaxTokens(translatedBody);
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    translatedBody.model = model;
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // RTK + optional stacked input-side Caveman: applied at the final body.
  // Pipeline mode (input-side Caveman, DEFAULT OFF) stacks RTK -> cavemanText
  // with marginal savings accounting. When the opt-in flag is off, the legacy
  // RTK-only path runs and behavior is byte-identical to before.
  if (rtkEnabled && inputCavemanEnabled) {
    const pipelineReport = runCompressionPipeline(translatedBody, {
      steps: ["rtk", "cavemanText"],
      inputCaveman: true,
      cavemanOptions: { intensity: cavemanLevel === "lite" ? "lite" : "full" },
    });
    const pipelineLine = formatPipelineLog(pipelineReport);
    if (pipelineLine) console.log(pipelineLine);
  } else {
    const rtkStats = compressMessages(translatedBody, rtkEnabled);
    const rtkLine = formatRtkLog(rtkStats);
    if (rtkLine) console.log(rtkLine);
  }

  // Context Auto-Compaction: prune oldest messages when prompt exceeds provider input budget
  const compactionResult = compactContext(translatedBody, provider);
  if (compactionResult.error) {
    trackPendingRequest(model, provider, connectionId, false, true);
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, compactionResult.error.error.message, compactionResult.error);
  }
  // compactionMeta is threaded through result objects so callers can inject X-9Router-Compacted headers
  const compactionMeta = compactionResult.compacted ? compactionResult : null;
  if (compactionMeta) {
    translatedBody = compactionResult.body;
    log?.info?.(
      "COMPACT",
      `${provider.toUpperCase()} | ${model} | dropped=${compactionResult.dropped} msgs | ` +
      `tokens: ${compactionResult.tokensBefore} → ${compactionResult.tokensAfter}`
    );
  }

  // Caveman: inject terse-style system prompt
  if (cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    log?.debug?.("CAVEMAN", `${cavemanLevel} | ${finalFormat}`);
  }

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  // Adaptive token reduction state
  const maxTokensUsed = translatedBody.max_tokens || getAdaptiveMaxTokens(provider, model) || DEFAULT_MAX_TOKENS;

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log, provider, model
  });

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request (with adaptive token retry on token-limit errors)
  let providerResponse, providerUrl, providerHeaders, finalBody;
  const MAX_ADAPTIVE_RETRIES = 6;
  for (let attempt = 0; attempt <= MAX_ADAPTIVE_RETRIES; attempt++) {
    try {
      const result = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
      providerResponse = result.response;
      providerUrl = result.url;
      providerHeaders = result.headers;
      finalBody = result.transformedBody;
      reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
      break; // Success — exit retry loop
    } catch (error) {
      if (error.name === "AbortError") {
        trackPendingRequest(model, provider, connectionId, false, true);
        appendRequestLog({ model, provider, connectionId, status: "FAILED 499" }).catch(() => { });
        saveRequestDetail(buildRequestDetail({
          provider, model, connectionId,
          latency: { ttft: 0, total: Date.now() - requestStartTime },
          tokens: { prompt_tokens: 0, completion_tokens: 0 },
          request: extractRequestConfig(body, stream),
          providerRequest: translatedBody || null,
          response: { error: error.message || String(error), status: 499, thinking: null },
          status: "error"
        })).catch(() => { });
        streamController.handleError(error);
        return createErrorResult(499, "Request aborted");
      }

      // Adaptive token retry: check if this is a token-limit error
      const errMsg = String(error.message || error);
      if (isTokenLimitError(errMsg, error.status || error.statusCode) && translatedBody.max_tokens > 0 && attempt < MAX_ADAPTIVE_RETRIES) {
        const newLimit = recordTokenLimitFailure(provider, model, translatedBody.max_tokens);
        log?.warn?.("ADAPTIVE", `${provider.toUpperCase()} | ${model} | token limit error → retry #${attempt + 1} with max_tokens=${newLimit} (was ${maxTokensUsed})`);
        console.log(`${COLORS.yellow}[ADAPTIVE] ${provider.toUpperCase()}/${model} | reducing max_tokens: ${maxTokensUsed} → ${newLimit} | retry #${attempt + 1}/${MAX_ADAPTIVE_RETRIES}${COLORS.reset}`);
        translatedBody.max_tokens = newLimit;
        // Re-translated body needs model re-set
        translatedBody.model = model;
        continue; // Retry with reduced tokens
      }

      // Non-retryable error
      trackPendingRequest(model, provider, connectionId, false, true);
      appendRequestLog({ model, provider, connectionId, status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
      saveRequestDetail(buildRequestDetail({
        provider, model, connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: translatedBody || null,
        response: { error: errMsg, status: 502, thinking: null },
        status: "error"
      })).catch(() => { });
      console.log(`${COLORS.red}[ERROR] ${formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY)}${COLORS.reset}`);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY));
    }
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      const newCredentials = await refreshWithRetry(() => executor.refreshCredentials(credentials, log), 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
          if (retryResult.response.ok) { providerResponse = retryResult.response; providerUrl = retryResult.url; }
        } catch { log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`); }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Provider returned error — adaptive token retry for token-limit errors
  if (!providerResponse.ok) {
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);

    let attempt = 0;
    let currentLimit = maxTokensUsed;
    let currentMessage = message;
    let currentStatusCode = statusCode;

    // Check if this is a token-limit error worth retrying
    while (!providerResponse.ok && isTokenLimitError(currentMessage, currentStatusCode) && currentLimit > 500 && attempt < 6) {
      attempt++;
      const newLimit = recordTokenLimitFailure(provider, model, currentLimit);
      log?.warn?.("ADAPTIVE", `${provider.toUpperCase()} | ${model} | token limit error ${currentStatusCode} → retry #${attempt} with max_tokens=${newLimit} (was ${currentLimit})`);
      console.log(`${COLORS.yellow}[ADAPTIVE] ${provider.toUpperCase()}/${model} | reducing max_tokens: ${currentLimit} → ${newLimit} | retry #${attempt}${COLORS.reset}`);

      currentLimit = newLimit;
      translatedBody.max_tokens = newLimit;
      translatedBody.model = model;
      
      try {
        const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
        providerResponse = retryResult.response;
        
        if (providerResponse.ok) {
          providerUrl = retryResult.url;
          providerHeaders = retryResult.headers;
          finalBody = retryResult.transformedBody;
          reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
          log?.info?.("ADAPTIVE", `${provider.toUpperCase()} | ${model} | retry succeeded with max_tokens=${newLimit}`);
          break;
        } else {
          // Parse the new error to see if we should loop again
          const parsedErr = await parseUpstreamError(providerResponse, executor);
          currentMessage = parsedErr.message;
          currentStatusCode = parsedErr.statusCode;
        }
      } catch (retryErr) {
        log?.warn?.("ADAPTIVE", `${provider.toUpperCase()} | ${model} | retry after token reduction failed: ${retryErr.message}`);
        break; // Stop looping on network/hard errors
      }
    }

    // Still failing after potential retry
    if (!providerResponse.ok) {
      trackPendingRequest(model, provider, connectionId, false, true);
      appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
      saveRequestDetail(buildRequestDetail({
        provider, model, connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        response: { error: message, status: statusCode, thinking: null },
        status: "error"
      })).catch(() => { });

      const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
      console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
      reqLogger.logError(new Error(message), finalBody || translatedBody);
      return createErrorResult(statusCode, errMsg, resetsAtMs);
    }
  }

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false);

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, trackDone, appendLog });
    if (result) { streamController.handleComplete(); return { ...result, compactionMeta }; }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, reqLogger, toolNameMap, trackDone, appendLog });
    streamController.handleComplete();
    return { ...result, compactionMeta };
  }

  // Streaming response
  const { onStreamComplete } = buildOnStreamComplete({ ...sharedCtx });
  const streamResult = handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete });
  return { ...streamResult, compactionMeta };
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}

