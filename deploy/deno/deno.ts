import { serve, type ServeHandlerInfo } from "https://deno.land/std@0.224.0/http/server.ts";
import NpmWebSocket from "npm:ws@8";
import { Buffer } from "node:buffer";

const normalizeBaseUrl = (rawValue: string | undefined, fallback: string): string => {
  const candidate = (rawValue || "").trim() || fallback;
  try {
    return new URL(candidate).toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
};

const isWebSocketUpgrade = (req: Request): boolean => {
  const upgrade = (req.headers.get("upgrade") || "").toLowerCase();
  const connection = (req.headers.get("connection") || "").toLowerCase();
  return upgrade === "websocket" || connection.includes("upgrade");
};

const findBestMapping = (
  pathname: string,
  mappings: Record<string, string>,
): { matchedPrefix: string; targetBaseUrl: string } | null => {
  const sortedPrefixes = Object.keys(mappings).sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    if (pathname.startsWith(prefix)) {
      return { matchedPrefix: prefix, targetBaseUrl: mappings[prefix] };
    }
  }
  return null;
};

const buildTargetUrl = (
  incomingUrl: URL,
  matchedPrefix: string,
  targetBaseUrlString: string,
): URL => {
  const parsedTargetBaseUrl = new URL(targetBaseUrlString);
  const suffixPath = incomingUrl.pathname.substring(matchedPrefix.length);

  let baseForNewUrl = parsedTargetBaseUrl.href;
  if (parsedTargetBaseUrl.pathname !== "/" && !baseForNewUrl.endsWith("/")) {
    baseForNewUrl += "/";
  }

  let pathForNewUrl = suffixPath;
  if (pathForNewUrl.startsWith("/")) {
    pathForNewUrl = pathForNewUrl.substring(1);
  }

  return new URL(pathForNewUrl + incomingUrl.search, baseForNewUrl);
};

const wsUrlToHttpUrl = (url: URL): URL => {
  const converted = new URL(url.toString());
  if (converted.protocol === "wss:") {
    converted.protocol = "https:";
  } else if (converted.protocol === "ws:") {
    converted.protocol = "http:";
  }
  return converted;
};

const stripToOrigin = (rawUrl: string): string | null => {
  try {
    const u = new URL(rawUrl);
    return u.origin;
  } catch {
    return null;
  }
};

const normalizeReferer = (rawUrl: string): string | null => {
  try {
    return new URL(rawUrl).toString();
  } catch {
    return null;
  }
};

const buildProxyHeaders = (
  sourceHeaders: Headers,
  targetHost: string,
  forceOrigin?: string,
): Headers => {
  const headers = new Headers(sourceHeaders);
  headers.set("Host", targetHost);
  headers.delete("X-Forwarded-For");
  headers.delete("X-Real-IP");
  headers.delete("Forwarded");
  headers.delete("Via");

  // 标准化 Origin（必须是纯 origin）和 Referer（必须是合法 URL）
  const origin = headers.get("Origin");
  if (origin) {
    const normalizedOrigin = stripToOrigin(origin);
    if (normalizedOrigin) {
      headers.set("Origin", normalizedOrigin);
    } else {
      headers.delete("Origin");
    }
  }
  const referer = headers.get("Referer");
  if (referer) {
    const normalizedReferer = normalizeReferer(referer);
    if (normalizedReferer) {
      headers.set("Referer", normalizedReferer);
    } else {
      headers.delete("Referer");
    }
  }

  // 可选：在 Deno Deploy 侧强制覆盖 WS Origin（仅在上游严格校验时启用）
  if (forceOrigin) {
    if (headers.has("Origin")) {
      headers.set("Origin", forceOrigin);
    }
    if (headers.has("Referer")) {
      headers.set("Referer", `${forceOrigin}/`);
    }
  }
  return headers;
};

const grokBaseUrl = normalizeBaseUrl(Deno.env.get("GROK_BASE_URL"), "https://grok.com");
const grokAssetsBaseUrl = normalizeBaseUrl(
  Deno.env.get("GROK_ASSETS_BASE_URL"),
  "https://assets.grok.com",
);
const grokWsBaseUrl = normalizeBaseUrl(Deno.env.get("GROK_WS_BASE_URL"), "wss://grok.com");
const livekitHttpBaseUrl = normalizeBaseUrl(
  Deno.env.get("LIVEKIT_BASE_URL"),
  "https://livekit.grok.com",
);
const livekitWsBaseUrl = normalizeBaseUrl(
  Deno.env.get("LIVEKIT_WS_BASE_URL"),
  "wss://livekit.grok.com",
);
const wsOriginOverride = (Deno.env.get("WS_ORIGIN_OVERRIDE") || "").trim();

// HTTP 路径映射
const pathMappings: Record<string, string> = {
  "/anthropic": "https://api.anthropic.com",
  "/gemini": "https://generativelanguage.googleapis.com",
  "/openai": "https://api.openai.com",
  "/openrouter": "https://openrouter.ai/api",
  "/xai": "https://api.x.ai",
  "/telegram": "https://api.telegram.org",
  "/discord": "https://discord.com/api",
  "/groq": "https://api.groq.com/openai",
  "/cohere": "https://api.cohere.ai",
  "/huggingface": "https://api-inference.huggingface.co",
  "/together": "https://api.together.xyz",
  "/novita": "https://api.novita.ai",
  "/portkey": "https://api.portkey.ai",
  "/fireworks": "https://api.fireworks.ai/inference",
  "/koofr": "https://app.koofr.net",
  "/grok": grokBaseUrl,
  "/grok-assets": grokAssetsBaseUrl,
  "/livekit": livekitHttpBaseUrl,
};

// WebSocket 路径映射
const wsPathMappings: Record<string, string> = {
  "/grok": grokWsBaseUrl,
  "/grok-livekit": livekitWsBaseUrl,
};

const port = parseInt(Deno.env.get("PORT") || "8000");

console.log(`代理服务器正在启动，监听端口: http://localhost:${port}`);
console.log(`Grok HTTP 目标: ${grokBaseUrl}`);
console.log(`Grok 资源目标: ${grokAssetsBaseUrl}`);
console.log(`Grok WS 目标: ${grokWsBaseUrl}`);
console.log(`LiveKit WS 目标: ${livekitWsBaseUrl}`);
if (wsOriginOverride) {
  console.log(`WS Origin 强制覆盖: ${wsOriginOverride}`);
}

serve(async (req: Request, _connInfo: ServeHandlerInfo) => {
  const incomingUrl = new URL(req.url);
  const incomingPathname = incomingUrl.pathname;
  const wsUpgrade = isWebSocketUpgrade(req);

  const createSecureHeaders = (contentType?: string): Headers => {
    const headers = new Headers();
    if (contentType) {
      headers.set("Content-Type", contentType);
    }
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    return headers;
  };

  if (incomingPathname === "/" || incomingPathname === "/index.html") {
    return new Response(null, {
      status: 404,
      headers: createSecureHeaders(),
    });
  }

  if (incomingPathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /", {
      status: 200,
      headers: createSecureHeaders("text/plain"),
    });
  }

  const mapping = wsUpgrade
    ? (findBestMapping(incomingPathname, wsPathMappings) ||
      findBestMapping(incomingPathname, pathMappings))
    : findBestMapping(incomingPathname, pathMappings);

  if (!mapping) {
    console.warn(`[${new Date().toISOString()}] 未找到路径映射: ${incomingPathname}`);
    return new Response("未找到: 此路径没有代理映射。", {
      status: 404,
      headers: createSecureHeaders("text/plain"),
    });
  }

  const matchedPrefix = mapping.matchedPrefix;
  const suffixPath = incomingPathname.substring(matchedPrefix.length);
  const finalTargetUrl = buildTargetUrl(
    incomingUrl,
    matchedPrefix,
    mapping.targetBaseUrl,
  );

  if (wsUpgrade) {
    const wsTargetUrl = finalTargetUrl.toString(); // 保留 wss:// 协议

    // 从客户端请求中提取需要转发的 headers（Cookie 等认证信息）
    const forwardHeaders: Record<string, string> = {};
    const headersToCopy = [
      "cookie", "origin", "user-agent", "accept-language",
      "cache-control", "pragma", "sec-ch-ua", "sec-ch-ua-mobile",
      "sec-ch-ua-platform", "sec-ch-ua-arch", "sec-ch-ua-bitness",
      "sec-ch-ua-model",
    ];
    for (const key of headersToCopy) {
      const value = req.headers.get(key);
      if (value) {
        forwardHeaders[key] = value;
      }
    }

    // 覆盖 Origin（如果配置了强制覆盖）
    if (wsOriginOverride) {
      if (forwardHeaders["origin"]) {
        forwardHeaders["origin"] = wsOriginOverride;
      }
    }

    // 诊断日志
    const debugHeaders = { ...forwardHeaders };
    if (debugHeaders["cookie"]) {
      debugHeaders["cookie"] = debugHeaders["cookie"].substring(0, 20) + "...<redacted>";
    }
    console.log(
      `[${new Date().toISOString()}] WS bridge: ${incomingPathname} -> ${wsTargetUrl}`,
    );
    console.log(
      `[${new Date().toISOString()}] WS bridge headers: ${JSON.stringify(debugHeaders)}`,
    );

    try {
      // 1. 接受客户端的 WebSocket 连接
      const { socket: clientWs, response } = Deno.upgradeWebSocket(req);

      // 2. 使用 npm:ws 连接上游（支持自定义 headers，使用 HTTP/1.1）
      const upstreamWs = new NpmWebSocket(wsTargetUrl, {
        headers: forwardHeaders,
        handshakeTimeout: 30000,
      });

      console.log(
        `[${new Date().toISOString()}] WS bridge: npm:ws 上游对象已创建`,
      );

      // 3. 等待上游连接建立
      const upstreamReady = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("上游 WebSocket 连接超时 (30s)"));
        }, 30000);

        upstreamWs.on("open", () => {
          clearTimeout(timeout);
          console.log(
            `[${new Date().toISOString()}] WS bridge: 上游已连接 ✓`,
          );
          resolve();
        });

        upstreamWs.on("error", (err: Error) => {
          clearTimeout(timeout);
          console.error(
            `[${new Date().toISOString()}] WS bridge: 上游连接错误:`,
            err.message,
          );
          reject(err);
        });
      });

      // 4. 双向桥接
      const pendingMessages: (string | ArrayBuffer | Buffer)[] = [];
      let upstreamOpen = false;

      // 客户端 -> 上游
      clientWs.onopen = () => {
        console.log(
          `[${new Date().toISOString()}] WS bridge: 客户端已连接 ✓`,
        );
      };

      clientWs.onmessage = (event: MessageEvent) => {
        if (upstreamOpen && upstreamWs.readyState === NpmWebSocket.OPEN) {
          upstreamWs.send(event.data);
        } else {
          pendingMessages.push(event.data);
        }
      };

      clientWs.onclose = (event: CloseEvent) => {
        console.log(
          `[${new Date().toISOString()}] WS bridge: 客户端断开 code=${event.code}`,
        );
        if (upstreamWs.readyState === NpmWebSocket.OPEN || upstreamWs.readyState === NpmWebSocket.CONNECTING) {
          try { upstreamWs.close(event.code, event.reason); } catch { /* */ }
        }
      };

      clientWs.onerror = () => {
        console.error(`[${new Date().toISOString()}] WS bridge: 客户端错误`);
        if (upstreamWs.readyState === NpmWebSocket.OPEN || upstreamWs.readyState === NpmWebSocket.CONNECTING) {
          try { upstreamWs.close(1011, "客户端错误"); } catch { /* */ }
        }
      };

      // 上游 -> 客户端
      upstreamReady.then(() => {
        upstreamOpen = true;

        // 发送缓存的客户端消息
        for (const msg of pendingMessages) {
          if (upstreamWs.readyState === NpmWebSocket.OPEN) {
            upstreamWs.send(msg);
          }
        }
        pendingMessages.length = 0;

        // npm:ws 使用 .on() 事件模型，data 是原始数据（Buffer/string）
        upstreamWs.on("message", (data: Buffer | string, isBinary: boolean) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            if (isBinary) {
              clientWs.send(new Uint8Array(data as Buffer));
            } else {
              clientWs.send(typeof data === "string" ? data : String(data));
            }
          }
        });

        upstreamWs.on("close", (code: number, reason: Buffer) => {
          console.log(
            `[${new Date().toISOString()}] WS bridge: 上游断开 code=${code}`,
          );
          if (clientWs.readyState === WebSocket.OPEN) {
            try { clientWs.close(code, reason.toString()); } catch { /* */ }
          }
        });

        upstreamWs.on("error", (err: Error) => {
          console.error(`[${new Date().toISOString()}] WS bridge: 上游运行时错误:`, err.message);
          if (clientWs.readyState === WebSocket.OPEN) {
            try { clientWs.close(1011, "上游错误"); } catch { /* */ }
          }
        });
      }).catch((err: Error) => {
        console.error(
          `[${new Date().toISOString()}] WS bridge: 上游连接失败:`,
          err.message,
        );
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1011, "上游连接失败");
        }
      });

      return response;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] WS bridge 初始化出错:`,
        error,
      );
      return new Response("网关错误: WebSocket 代理初始化失败。", {
        status: 502,
        headers: createSecureHeaders("text/plain"),
      });
    }
  }



  const headersToProxy = buildProxyHeaders(req.headers, finalTargetUrl.host);
  const proxyReq = new Request(finalTargetUrl.toString(), {
    method: req.method,
    headers: headersToProxy,
    body: req.body,
    redirect: "manual",
  });

  try {
    const proxyRes = await fetch(proxyReq);

    if (matchedPrefix === "/koofr" && req.method === "PROPFIND") {
      const contentType = proxyRes.headers.get("Content-Type") || "";
      if (
        proxyRes.ok &&
        (contentType.includes("application/xml") || contentType.includes("text/xml"))
      ) {
        const originalBodyText = await proxyRes.text();
        if (suffixPath && suffixPath.length > 1) {
          const rewrittenBody = originalBodyText.replaceAll(
            suffixPath,
            incomingPathname,
          );

          const responseHeaders = new Headers(proxyRes.headers);
          responseHeaders.delete("Content-Length");
          responseHeaders.set("X-Content-Type-Options", "nosniff");
          responseHeaders.set("X-Frame-Options", "DENY");
          responseHeaders.set("Referrer-Policy", "no-referrer");

          return new Response(rewrittenBody, {
            status: proxyRes.status,
            statusText: proxyRes.statusText,
            headers: responseHeaders,
          });
        }
      }
    }

    const responseHeaders = new Headers(proxyRes.headers);
    responseHeaders.delete("Transfer-Encoding");
    responseHeaders.delete("Connection");
    responseHeaders.delete("Keep-Alive");
    responseHeaders.delete("Proxy-Authenticate");
    responseHeaders.delete("Proxy-Authorization");
    responseHeaders.delete("TE");
    responseHeaders.delete("Trailers");
    responseHeaders.delete("Upgrade");
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    responseHeaders.set("X-Frame-Options", "DENY");
    responseHeaders.set("Referrer-Policy", "no-referrer");

    return new Response(proxyRes.body, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] 请求目标URL时出错 ${finalTargetUrl.toString()}:`,
      error,
    );
    return new Response("网关错误: 连接上游服务器时出错。", {
      status: 502,
      headers: createSecureHeaders("text/plain"),
    });
  }
}, { port });
