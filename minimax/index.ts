/**
 * MiniMax AI Extension for pi
 *
 * Provides AI-powered tools:
 * - web_search: Search the web and get structured results
 * - understand_image: Analyze images using AI
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// Configuration - get API key from environment variable
const getConfig = () => ({
  apiKey: process.env.MINIMAX_API_KEY,
  apiHost: process.env.MINIMAX_API_HOST || "https://api.minimax.io",
});

// Validate config and throw helpful error if missing
function validateConfig() {
  const config = getConfig();
  if (!config.apiKey) {
    throw new Error("MINIMAX_API_KEY environment variable is not set");
  }
  if (!config.apiHost) {
    throw new Error("MINIMAX_API_HOST environment variable is not set");
  }
  return config;
}

// Response types matching MiniMax MCP server format
interface WebSearchResponse {
  organic: Array<{
    title: string;
    link: string;
    snippet: string;
    date?: string;
  }>;
  related_searches: Array<{
    query: string;
  }>;
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

interface VLMResponse {
  content: string;
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

/**
 * Process image URL and convert to base64 data URL format.
 * 
 * This function handles three types of image inputs:
 * 1. HTTP/HTTPS URLs: Downloads the image and converts to base64
 * 2. Base64 data URLs: Passes through as-is
 * 3. Local file paths: Reads the file and converts to base64
 */
async function processImageUrl(imageUrl: string): Promise<string> {
  // Remove @ prefix if present
  if (imageUrl.startsWith("@")) {
    imageUrl = imageUrl.substring(1);
  }
  
  // If already in base64 data URL format, pass through
  if (imageUrl.startsWith("data:")) {
    return imageUrl;
  }
  
  // Handle HTTP/HTTPS URLs
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    try {
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`);
      }
      const imageData = await imageResponse.arrayBuffer();
      
      // Detect image format from content-type header
      const contentType = imageResponse.headers.get('content-type')?.toLowerCase() || '';
      let imageFormat = 'jpeg'; // Default
      if (contentType.includes('png')) {
        imageFormat = 'png';
      } else if (contentType.includes('webp')) {
        imageFormat = 'webp';
      } else if (contentType.includes('jpeg') || contentType.includes('jpg')) {
        imageFormat = 'jpeg';
      }
      
      // Convert to base64 data URL
      const base64Data = Buffer.from(imageData).toString('base64');
      return `data:image/${imageFormat};base64,${base64Data}`;
      
    } catch (error) {
      throw new Error(`Failed to download image from URL: ${error}`);
    }
  }
  
  // Handle local file paths (including Windows paths)
  else {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      // Resolve the file path
      const resolvedPath = path.resolve(imageUrl);
      const fileHandle = await fs.open(resolvedPath, 'r');
      const fileBuffer = await fileHandle.readFile();
      await fileHandle.close();
      
      // Detect image format from file extension
      let imageFormat = 'jpeg'; // Default
      const lowerPath = resolvedPath.toLowerCase();
      if (lowerPath.endsWith('.png')) {
        imageFormat = 'png';
      } else if (lowerPath.endsWith('.webp')) {
        imageFormat = 'webp';
      } else if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) {
        imageFormat = 'jpeg';
      }
      
      const base64Data = fileBuffer.toString('base64');
      return `data:image/${imageFormat};base64,${base64Data}`;
      
    } catch (error) {
      throw new Error(`Failed to read local image file: ${error}`);
    }
  }
}

export default function (pi: ExtensionAPI) {
  // Notify on load
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("MiniMax extension loaded", "info");
  });

  // Register web_search tool
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the web using MiniMax AI and get structured search results.

    Returns organic search results with titles, URLs, snippets, and related searches.
    Use this to find up-to-date information on any topic.`,
    parameters: Type.Object({
      query: Type.String({
        description: "The search query",
        examples: ["latest AI news", "TypeScript best practices 2024"],
      }),
      num_results: Type.Optional(Type.Number({
        description: "Number of results to return (default: 5)",
        minimum: 1,
        maximum: 20,
      })),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      const config = validateConfig();
      const url = `${config.apiHost}/v1/coding_plan/search`;

      onUpdate?.({
        content: [{ type: "text", text: `Searching: "${params.query}"...` }],
        details: { status: "searching", query: params.query },
      });

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "MM-API-Source": "Minimax-MCP",
          },
          body: JSON.stringify({
            q: params.query,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`MiniMax API error (${response.status}): ${errorText}`);
        }

        const result: WebSearchResponse = await response.json();

        // Check for API error
        if (result.base_resp.status_code !== 0) {
          throw new Error(`MiniMax API error (${result.base_resp.status_code}): ${result.base_resp.status_msg}`);
        }

        // Format results for the LLM
        let output = `## Web Search Results: "${params.query}"\n\n`;

        if (result.organic && result.organic.length > 0) {
          for (const r of result.organic) {
            output += `### ${r.title}\n`;
            output += `- **URL:** ${r.link}\n`;
            output += `- **Snippet:** ${r.snippet}\n\n`;
          }
        }

        if (result.related_searches && result.related_searches.length > 0) {
          output += `## Related Searches\n\n`;
          for (const rs of result.related_searches) {
            output += `- ${rs.query}\n`;
          }
        }

        return {
          content: [{ type: "text", text: output }],
          details: {
            query: params.query,
            resultCount: result.organic?.length || 0,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `❌ **Search Error:**\n\n${errorMessage}` }],
          details: { error: errorMessage, query: params.query },
          isError: true,
        };
      }
    },
  });

  // Register understand_image tool
  pi.registerTool({
    name: "understand_image",
    label: "Understand Image",
    description: `Analyze images using MiniMax AI and get detailed understanding.

    Supports:
    - Local file paths
    - Image URLs (JPEG, PNG, WebP formats)

    Returns AI-generated description and answers about the image.`,
    parameters: Type.Object({
      image: Type.String({
        description: "URL or local path to the image",
        examples: [
          "https://example.com/image.png",
          "./screenshot.png",
          "/home/user/photo.jpg",
        ],
      }),
      prompt: Type.Optional(
        Type.String({
          description: "Question or prompt about the image (default: describe the image)",
          examples: [
            "What does this diagram show?",
            "List all the objects in this image",
            "Extract any text visible in this image",
          ],
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      const config = validateConfig();
      const url = `${config.apiHost}/v1/coding_plan/vlm`;

      onUpdate?.({
        content: [{ type: "text", text: `Analyzing image...` }],
        details: { status: "analyzing", image: params.image },
      });

      try {
        // Process image URL (convert to base64 data URL)
        const processedImageUrl = await processImageUrl(params.image);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "MM-API-Source": "Minimax-MCP",
          },
          body: JSON.stringify({
            image_url: processedImageUrl,
            prompt: params.prompt || "Describe this image in detail",
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`MiniMax API error (${response.status}): ${errorText}`);
        }

        const result: VLMResponse = await response.json();

        // Check for API error
        if (result.base_resp.status_code !== 0) {
          throw new Error(`MiniMax API error (${result.base_resp.status_code}): ${result.base_resp.status_msg}`);
        }

        return {
          content: [{ type: "text", text: `## Image Analysis\n\n${result.content || ""}` }],
          details: {
            image: params.image,
            prompt: params.prompt || "Describe this image in detail",
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `❌ **Image Analysis Error:**\n\n${errorMessage}` }],
          details: { error: errorMessage, image: params.image },
          isError: true,
        };
      }
    },
  });
}
