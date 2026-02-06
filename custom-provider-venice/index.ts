/**
 * Venice.ai Provider Extension
 *
 * Provides access to Venice AI models through their OpenAI-compatible API.
 * Fetches available models from the API and filters for models that support tool calls.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-venice
 *   # Set VENICE_API_KEY environment variable
 */

import {
	type Api,
	type Model,
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const VENICE_API_URL = "https://api.venice.ai/api/v1";

// =============================================================================
// Venice API Response Types
// =============================================================================

interface VeniceModelResponse {
  data: ModelData[];
}
interface ModelData {
	created: number;
	id: string;
	model_spec: {
		availableContextTokens: number;
		capabilities: {
			optimizedForCode: boolean;
			quantization: string;
			supportsFunctionCalling: boolean;
			supportsReasoning: boolean;
			supportsResponseSchema: boolean;
			supportsVision: boolean;
			supportsWebSearch: boolean;
			supportsLogProbs: boolean;
		};
		constraints: {
			temperature?: { default: number };
			top_p?: { default: number };
		};
		description: string;
		name: string;
		modelSource: string;
		offline: boolean;
		privacy: string;
		pricing: {
			input: { usd: number; diem: number };
			output: { usd: number; diem: number };
      cache_input: { usd: number; diem: number };
      cache_output: { usd: number; diem: number };
		};
		traits: string[];
	};
	object: "model";
	owned_by: string;
	type: "text";
}

// =============================================================================
// Fetch Models from Venice API
// =============================================================================

async function fetchVeniceModels(apiKey: string): Promise<Model<Api>[]> {
	const response = await fetch(`${VENICE_API_URL}/models`, {
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch Venice models: ${response.statusText}`);
	}

  const data = await response.json() as VeniceModelResponse;

	// Filter for models that support tool calls
	const models: Model<Api>[] = data.data
		.filter((model) => model.model_spec?.capabilities?.supportsFunctionCalling)
		.map((model) => {
			const spec = model.model_spec;
			const pricing = spec.pricing;

			return {
				id: model.id,
				name: spec.name,
				reasoning: spec.capabilities.supportsReasoning,
				input: spec.capabilities.supportsVision ? ["text", "image"] : ["text"],
				cost: { input: pricing.input.usd, output: pricing.output.usd, cacheRead: pricing.cache_input?.usd || 0, cacheWrite: pricing.cache_output?.usd || 0 },
				contextWindow: spec.availableContextTokens,
				maxTokens: 16384, // Default max tokens for Venice models
			};
		});

	return models;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
	const apiKey = process.env.VENICE_API_KEY;

	if (!apiKey) {
		throw new Error("VENICE_API_KEY environment variable is not set");
	}

	const models = await fetchVeniceModels(apiKey);

	if (models.length === 0) {
		throw new Error("No models with tool call support found in Venice API response");
	}

	pi.registerProvider("venice", {
		baseUrl: VENICE_API_URL,
		apiKey: "VENICE_API_KEY",
		api: "openai-completions",
		models: models,
	});
}
