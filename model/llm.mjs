/**
 * Bonsai 线唯一模型客户端：OpenAI 兼容 /v1（llama.cpp 或 LLMpod 网关）。
 *
 * 这层只做两件事：
 *   1. 把 llamacpp.mjs 的模型/能力/流式接口原样暴露（它是纯 OpenAI 兼容客户端 + 本机进程管理）；
 *   2. 统一内模型名带 `llama/` 前缀（沿用现成适配层的约定，UI 显示时去掉）。
 * 不导入、不调用任何 Ollama 接口。
 */
import {
  PREFIX,
  displayName as llamaDisplayName,
  listModels as llamaListModels,
  listLoaded as llamaListLoaded,
  modelCaps as llamaModelCaps,
  forgetModelCaps as llamaForgetModelCaps,
  clearCapsCache as llamaClearCapsCache,
  chatStream as llamaChatStream,
  ctxSize as llamaCtxSize,
  probe,
  ensureServer,
  stopServer,
  statusOf,
  modeOf,
  switchMode,
} from './llamacpp.mjs';

export const INTERNAL_PREFIX = PREFIX;
export { probe, ensureServer, stopServer, statusOf, modeOf, switchMode };

/** 模型显示名：去掉内部前缀；全路径取文件名 */
export function displayName(name) {
  return llamaDisplayName(String(name || '').slice(PREFIX.length));
}

export async function listModels() {
  return llamaListModels();
}

export async function listLoaded() {
  return llamaListLoaded();
}

/** 本线没有 Ollama 的 capabilities 表：按 llama.cpp 实际能力补齐（模板带 tools 才给工具） */
export async function modelCaps(name) {
  const info = await llamaModelCaps(name).catch(() => ({ caps: [], contextLength: 0 }));
  const caps = [...(info.caps || [])];
  if (!caps.includes('completion')) caps.push('completion');
  return { caps, contextLength: Number(info.contextLength) || 0 };
}

export function forgetModelCaps(name) {
  llamaForgetModelCaps(name);
}

/**
 * 端点真实上下文（/props 的 n_ctx，缓存 30s）。压缩阈值与 chat 裁剪共用这一个口径：
 * 之前压缩路径只看 extraArgs 的 -c，外部端点下永远拿不到 131072，长会话 4k token 就白烧一次摘要调用。
 * 拉不起来返回 0（调用方自己回退到 -c / 8192）。
 */
export async function ctxSize() {
  return llamaCtxSize().catch(() => 0);
}

export function clearCapsCache() {
  llamaClearCapsCache();
}

/** 流式对话：入参是内部（Ollama 风格）body，输出也是内部 chunk 形状 */
export async function* chatStream(body, signal) {
  yield* llamaChatStream(body, signal);
}
