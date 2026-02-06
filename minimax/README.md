# MiniMax Extension for pi

AI-powered extension providing web search and image understanding tools.

## Tools

### `web_search`
Search the web and get structured results with titles, URLs, snippets, and related searches.

### `understand_image`
Analyze images using AI - supports URLs and local file paths.

## Setup

### 1. Get MiniMax API Key

1. Sign up at [MiniMax Platform](https://www.minimax.io/platform)
2. Get your API key from your account settings
3. Note your region and corresponding API host:
   - **Global**: `https://api.minimax.io`
   - **Mainland China**: `https://api.minimax.cn`

### 2. Configure Environment Variables

Set the required environment variables before running pi:

```bash
# For Global users
export MINIMAX_API_KEY="your-api-key-here"
export MINIMAX_API_HOST="https://api.minimax.io"

# For Mainland China users
export MINIMAX_API_KEY="your-api-key-here"
export MINIMAX_API_HOST="https://api.minimax.cn"
```

### 3. Add to pi Settings

Add the extension path to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "...existing packages...",
    ".../path/to/pi-ext/minimax"
  ]
}
```

## Usage

### Web Search Example
```
Search for: "latest TypeScript features 2024"
```

### Image Analysis Example
```
Analyze: "./screenshot.png"
Prompt: "What does this diagram show?"
```

## Requirements

- pi-coding-agent
- MINIMAX_API_KEY environment variable
- MINIMAX_API_HOST environment variable (optional, defaults to https://api.minimax.io)
