// A completed receipt, not an HTTP 200 or a closed connection, means sharing succeeded.
export async function readShareStream(response, onProgress, operation = "共享") {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${operation}请求失败。`);
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body) {
    throw new Error(`${operation}进度响应无效。`);
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 2 * 1024 * 1024) throw new Error(`${operation}进度响应过大。`);
      const lines = pending.split("\n"); pending = lines.pop();
      if (done && pending.trim()) lines.push(pending);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "error") throw new Error(event.message || `${operation}未完成。`);
        if (event.type === "progress") onProgress(event);
        if (event.type === "complete") {
          if (!event.result?.id || !event.result?.context_id) throw new Error(`${operation}完成回执无效。`);
          return event.result;
        }
      }
      if (done) throw new Error(operation === "任务创建"
        ? "连接中断，尚未收到任务创建完成回执；请刷新任务列表确认后再重试。"
        : `连接中断，尚未收到${operation}完成回执；可以重试。`);
    }
  } finally { reader.releaseLock(); }
}
