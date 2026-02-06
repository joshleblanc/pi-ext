import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

/**
 * URL Browser Extension for pi
 * v2 - cache-bust timestamp: 2026-02-06T12:10:00Z
 *
 * Provides tools for browsing and fetching content from URLs.
 * Supports HTML, JSON, and plain text responses.
 */

interface FetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  followRedirects?: boolean;
  userAgent?: string;
}

interface FetchResult {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentType: string;
  content: string;
  redirected: boolean;
  redirectedUrls: string[];
}

interface BrowserState {
  history: Array<{ url: string; title: string; timestamp: number }>;
  currentUrl?: string;
}

const state: BrowserState = {
  history: [],
};

async function fetchUrl(options: FetchOptions): Promise<FetchResult> {
  const {
    url,
    method = "GET",
    headers = {},
    body,
    timeout = 30000,
    followRedirects = true,
    userAgent = "Mozilla/5.0 (compatible; pi-browser/1.0)",
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const requestHeaders: Record<string, string> = {
    "User-Agent": userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    ...headers,
  };

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body,
      signal: controller.signal,
      redirect: followRedirects ? "follow" : "manual",
    });

    clearTimeout(timeoutId);

    // Get response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    // Determine content type
    const contentType = responseHeaders["content-type"] || "";
    const content = await response.text();

    // Collect redirect history
    const redirectedUrls: string[] = [];
    if (response.redirected) {
      // @ts-ignore - redirected URL is available in some fetch implementations
      redirectedUrls.push(response.url);
    }

    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      contentType,
      content,
      redirected: response.redirected,
      redirectedUrls,
    };
  } catch (error) {
    clearTimeout(timeout);
    throw new Error(
      `Failed to fetch ${url}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

function extractHtmlTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return titleMatch ? titleMatch[1].trim() : "";
}

function extractLinks(html: string, baseUrl: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim(); // Strip any nested tags

    // Skip empty or javascript links
    if (href && !href.startsWith("javascript:") && href !== "#") {
      // Resolve relative URLs
      let resolvedHref = href;
      try {
        resolvedHref = new URL(href, baseUrl).href;
      } catch {
        // Keep original if URL parsing fails
      }

      links.push({ text: text || href, href: resolvedHref });
    }
  }

  return links.slice(0, 50); // Limit to 50 links
}

function formatHtmlForLlm(result: FetchResult): string {
  let output = `## Page Information\n`;
  output += `- **URL:** ${result.url}\n`;
  output += `- **Status:** ${result.status} ${result.statusText}\n`;
  output += `- **Content Type:** ${result.contentType}\n`;
  output += `- **Redirected:** ${result.redirected ? "Yes" : "No"}\n\n`;

  output += `## Content\n\n`;

  // Extract and show title
  const title = extractHtmlTitle(result.content);
  if (title) {
    output += `### ${title}\n\n`;
  }

  // Try to extract main content from HTML
  const isHtml = result.contentType.includes("text/html");
  let content = result.content;

  if (isHtml) {
    // Remove script and style elements
    content = content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      // Remove all remaining tags
      .replace(/<[^>]+>/g, " ")
      // Decode common HTML entities
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Clean up whitespace
      .replace(/\s+/g, " ")
      .trim();
  }

  // Truncate if too long
  const maxLength = 10000;
  if (content.length > maxLength) {
    output += content.slice(0, maxLength) + "\n\n_[Content truncated for length]_";
  } else {
    output += content;
  }

  // Extract and show links if requested
  if (isHtml && extractLinks) {
    const links = extractLinks(result.content, result.url);
    if (links.length > 0) {
      output += `\n\n## Links Found (${links.length} total, showing first 20)\n\n`;
      for (const link of links.slice(0, 20)) {
        output += `- [${link.text}](${link.href})\n`;
      }
    }
  }

  // Show headers if present
  if (Object.keys(result.headers).length > 0) {
    const interestingHeaders = ["content-length", "last-modified", "etag", "server"];
    output += `\n\n## Response Headers\n\n`;
    for (const [key, value] of Object.entries(result.headers)) {
      if (interestingHeaders.includes(key)) {
        output += `- **${key}:** ${value}\n`;
      }
    }
  }

  return output;
}

function formatJsonForLlm(result: FetchResult): string {
  let output = `## JSON Response\n`;
  output += `- **URL:** ${result.url}\n`;
  output += `- **Status:** ${result.status} ${result.statusText}\n\n`;

  try {
    const parsed = JSON.parse(result.content);
    output += "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
  } catch {
    output += "```\n" + result.content.slice(0, 10000) + "\n```\n_[Invalid JSON or truncated]_";
  }

  return output;
}

function formatTextForLlm(result: FetchResult): string {
  let output = `## Text Content\n`;
  output += `- **URL:** ${result.url}\n`;
  output += `- **Status:** ${result.status} ${result.statusText}\n`;
  output += `- **Content Type:** ${result.contentType}\n\n`;

  const maxLength = 15000;
  const content = result.content.length > maxLength
    ? result.content.slice(0, maxLength) + "\n\n_[Content truncated for length]_"
    : result.content;

  output += "```\n" + content + "\n```";

  return output;
}

export default function (pi: ExtensionAPI) {
  // Notify on load
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("URL Browser loaded", "info");
  });

  // Register the browse tool
  pi.registerTool({
    name: "browse",
    label: "Browse URL",
    description: `Fetch and display content from a URL. Supports HTML, JSON, and plain text.

    - Automatically extracts page titles and main content from HTML
    - Lists discovered links (up to 20) for HTML pages
    - Formats JSON responses with syntax highlighting
    - Shows HTTP status and response headers

    Use this to fetch documentation, APIs, or any web content.`,
    parameters: Type.Object({
      url: Type.String({
        description: "The URL to fetch",
        examples: ["https://example.com", "https://api.github.com/users/octocat"],
      }),
      method: Type.Optional(
        StringEnum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const, {
          description: "HTTP method to use (default: GET)",
          examples: ["GET", "POST"],
        })
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Additional HTTP headers as key-value pairs",
        })
      ),
      body: Type.Optional(Type.String({
        description: "Request body for POST/PUT/PATCH requests (e.g., JSON data)",
        examples: ['{"key": "value"}'],
      })),
      timeout: Type.Optional(Type.Number({
        description: "Request timeout in milliseconds (default: 30000, max: 60000)",
        minimum: 1000,
        maximum: 60000,
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const url = params.url;
      const method = params.method || "GET";
      const headers = params.headers || {};
      const body = params.body;
      const timeout = Math.min(params.timeout || 30000, 60000);

      // Notify starting
      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}...` }],
        details: { status: "fetching", url },
      });

      try {
        // Validate URL
        new URL(url);

        const result = await fetchUrl({
          url,
          method,
          headers,
          body,
          timeout,
          followRedirects: true,
        });

        // Update state
        const title = extractHtmlTitle(result.content);
        state.history.unshift({
          url: result.url,
          title: title || new URL(result.url).hostname,
          timestamp: Date.now(),
        });
        state.history = state.history.slice(0, 100); // Keep last 100 entries
        state.currentUrl = result.url;

        // Format output based on content type
        let formattedContent: string;
        const contentType = result.contentType.toLowerCase();

        if (contentType.includes("application/json") || contentType.includes("+json")) {
          formattedContent = formatJsonForLlm(result);
        } else if (contentType.includes("text/html")) {
          formattedContent = formatHtmlForLlm(result);
        } else {
          formattedContent = formatTextForLlm(result);
        }

        // If not successful, show warning
        if (result.status >= 400) {
          formattedContent =
            `⚠️ **HTTP ${result.status} ${result.statusText}**\n\n` + formattedContent;
        }

        return {
          content: [{ type: "text", text: formattedContent }],
          details: {
            url: result.url,
            status: result.status,
            contentType: result.contentType,
            redirected: result.redirected,
            title: title || undefined,
            historyCount: state.history.length,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `❌ **Error fetching URL:**\n\n${errorMessage}` }],
          details: { error: errorMessage, url },
          isError: true,
        };
      }
    },
  });

  // Register browse_json tool for API calls
  pi.registerTool({
    name: "browse_json",
    label: "Browse JSON API",
    description: `Make HTTP requests to JSON APIs and get structured responses.

    Automatically:
    - Sets Content-Type: application/json header
    - Parses JSON responses with proper formatting
    - Shows request and response status

    Best for REST APIs, GraphQL endpoints, or any JSON web service.`,
    parameters: Type.Object({
      url: Type.String({
        description: "The API endpoint URL",
        examples: ["https://api.github.com/users/octocat", "https://jsonplaceholder.typicode.com/posts/1"],
      }),
      method: Type.Optional(
        StringEnum(["GET", "POST", "PUT", "DELETE", "PATCH"] as const, {
          description: "HTTP method (default: GET)",
        })
      ),
      body: Type.Optional(Type.String({
        description: "JSON request body (for POST/PUT/PATCH)",
        examples: ['{"title": "foo", "body": "bar", "userId": 1}'],
      })),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Additional headers (Authorization, etc.)",
        })
      ),
      timeout: Type.Optional(Type.Number({
        description: "Timeout in milliseconds (default: 30000)",
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const url = params.url;
      const method = params.method || "GET";
      const timeout = params.timeout || 30000;

      onUpdate?.({
        content: [{ type: "text", text: `Calling API: ${url}...` }],
        details: { status: "fetching", url },
      });

      try {
        new URL(url);

        const headers: Record<string, string> = {
          "Accept": "application/json",
          "Content-Type": "application/json",
          ...(params.headers || {}),
        };

        const result = await fetchUrl({
          url,
          method,
          headers,
          body: params.body,
          timeout,
        });

        state.currentUrl = result.url;

        let formatted = `## API Response\n`;
        formatted += `- **Endpoint:** ${url}\n`;
        formatted += `- **Method:** ${method}\n`;
        formatted += `- **Status:** ${result.status} ${result.statusText}\n`;
        formatted += `- **URL:** ${result.url}\n\n`;

        formatted += `## Response\n\n`;

        try {
          const parsed = JSON.parse(result.content);
          formatted += "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
        } catch {
          formatted += "```\n" + result.content.slice(0, 10000) + "\n```\n_[Invalid JSON or truncated]_";
        }

        if (result.status >= 400) {
          formatted = `⚠️ **HTTP ${result.status}**\n\n` + formatted;
        }

        return {
          content: [{ type: "text", text: formatted }],
          details: {
            url: result.url,
            status: result.status,
            method,
            contentType: result.contentType,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `❌ **API Error:**\n\n${error instanceof Error ? error.message : "Unknown error"}` }],
          details: { error: error instanceof Error ? error.message : "Unknown error", url },
          isError: true,
        };
      }
    },
  });

  // Register browse_history command
  pi.registerCommand("browse-history", {
    description: "Show browsing history",
    handler: async (args, ctx) => {
      if (state.history.length === 0) {
        ctx.ui.notify("No browsing history", "info");
        return;
      }

      const formatted = state.history
        .slice(0, 20)
        .map((entry, i) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          return `${i + 1}. [${entry.title}](${entry.url}) - ${time}`;
        })
        .join("\n");

      ctx.ui.notify(`Recent pages:\n\n${formatted}`, "info");
    },
  });

  // Register clear_history command
  pi.registerCommand("browse-clear", {
    description: "Clear browsing history",
    handler: async (args, ctx) => {
      state.history = [];
      ctx.ui.notify("Browsing history cleared", "info");
    },
  });

  // Intercept bash tool to handle URLs in commands
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      // Could add URL detection in bash commands here if needed
    }
  });
}
