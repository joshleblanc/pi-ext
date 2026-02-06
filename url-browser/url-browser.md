# URL Browser Extension for pi

A powerful URL browsing extension for the [pi coding agent](https://shittycodingagent.ai) that enables fetching and parsing web content.

## Features

### 🌐 `browse` Tool
Fetch any URL and get nicely formatted content:

- **HTML pages**: Extracts titles, main content, and lists up to 20 links
- **JSON APIs**: Pretty-prints with syntax highlighting
- **Plain text**: Preserves formatting
- **HTTP status**: Shows response codes and headers
- **Error handling**: Clear error messages for failed requests

**Example usage:**
```
Browse https://example.com
Browse https://api.github.com/users/octocat
Browse https://jsonplaceholder.typicode.com/posts/1 method=GET
```

### 🔧 `browse_json` Tool
Specialized tool for JSON APIs with automatic formatting:

```
browse_json url="https://api.github.com/users/octocat"
browse_json url="https://jsonplaceholder.typicode.com/posts" method="POST" body='{"title":"foo"}'
```

### Commands

- `/browse-history` - View recent browsing history
- `/browse-clear` - Clear all browsing history

## Installation

The extension is auto-discovered from `~/.pi/agent/extensions/`. Just create the file:

```bash
mkdir -p ~/.pi/agent/extensions/
# The extension should already be there if installed via pi install
```

Or test with the `-e` flag:

```bash
pi -e ~/.pi/agent/extensions/url-browser.ts
```

## Usage Examples

### Reading Documentation

```
browse https://docs.python.org/3/tutorial/
```

### Checking API Endpoints

```
browse_json url="https://api.github.com/repos/microsoft/typescript/stats/commit_activity"
```

### Following Links

The extension lists links on HTML pages. You can browse those URLs directly.

### Sending Data to APIs

```json
{
  "url": "https://jsonplaceholder.typicode.com/posts",
  "method": "POST",
  "body": "{\"title\": \"My Post\", \"body\": \"Content\", \"userId\": 1}",
  "headers": {
    "Authorization": "Bearer YOUR_TOKEN"
  }
}
```

## Options

### `browse` Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | The URL to fetch |
| `method` | GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS | GET | HTTP method |
| `headers` | object | {} | Additional headers |
| `body` | string | undefined | Request body |
| `timeout` | number | 30000 | Timeout in ms (max 60000) |
| `extractLinks` | boolean | true | Extract links from HTML |

### `browse_json` Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | API endpoint URL |
| `method` | GET/POST/PUT/DELETE/PATCH | GET | HTTP method |
| `body` | string | undefined | JSON request body |
| `headers` | object | {} | Additional headers |
| `timeout` | number | 30000 | Timeout in ms |

## Features in Detail

### Content Extraction
For HTML pages, the tool:
1. Strips navigation, footer, script, and style elements
2. Extracts the `<title>` for display
3. Cleans HTML tags and entities
4. Preserves readable text content
5. Lists up to 20 discovered links

### JSON Formatting
- Pretty-prints with 2-space indentation
- Syntax highlighting for easy reading
- Truncates very large responses (shows first 10KB)

### Error Handling
- Invalid URLs are rejected immediately
- Timeout errors after configurable duration
- HTTP errors (4xx, 5xx) are shown with response content
- Network errors include descriptive messages

## Requirements

- pi v0.1.0 or later
- Node.js 18+ (for fetch API)
- Network connectivity

## Tips

- Use `browse_json` for APIs - it sets appropriate headers automatically
- Set `timeout` higher for slow endpoints
- Add custom headers for authentication (Bearer tokens, API keys)
- The browsing history persists across sessions
