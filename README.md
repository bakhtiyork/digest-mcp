# Digest MCP Server

MCP server for web content digestion using [browserless.io](https://browserless.io) via puppeteer-core. Extracts fully rendered DOM content from dynamic web pages including SPAs and infinite scroll sites.

## Features

- Connect to browserless.io cloud browsers
- Load web pages with configurable wait times
- Scroll down pages multiple times with delays
- Extract complete page content (HTML)

## Installation

```bash
npm install
npm run build
```

## Configuration

Set your browserless.io API key using one of these methods:

### Option 1: Using .env file (recommended)

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Then edit `.env` and add your API key:

```
BROWSERLESS_API_KEY=your_api_key_here
```

### Option 2: Using environment variable

```bash
export BROWSERLESS_API_KEY=your_api_key_here
```

## Usage

### Running the Server

The server uses stdio transport for MCP communication:

```bash
node build/index.js
```

### Tool: web_content

Fetches web page content with optional scrolling and HTML cleanup.

**Parameters:**
- `url` (string, required): The URL to fetch
- `initialWaitTime` (number, optional): Time to wait in milliseconds after loading the page. Default: 3000
- `scrolls` (number, optional): Number of times to scroll down the page. Default: 0
- `scrollWaitTime` (number, optional): Time to wait in milliseconds between each scroll. Default: 1000
- `cleanup` (boolean, optional): Whether to clean up HTML (remove scripts, styles, SVG, forms, etc.) and keep only meaningful text content. Default: false

**Returns:**
- `size` (number): Size of the content in bytes
- `content` (string): The fetched HTML content

**Example:**

```json
{
  "url": "https://example.com",
  "initialWaitTime": 2000,
  "scrolls": 3,
  "scrollWaitTime": 1000,
  "cleanup": true
}
```

## How It Works

1. Connects to browserless.io using your API key via WebSocket
2. Creates a new page in the remote browser
3. Navigates to the specified URL (waits for DOM content loaded)
4. Waits 1 second for page stabilization
5. Waits for the initial wait time (default: 3 seconds)
6. Scrolls to the bottom of the page the specified number of times
7. After each scroll, intelligently waits for new content to load by:
   - Monitoring page height changes
   - Detecting dynamically loaded content
   - Waiting up to scrollWaitTime for new content (default: 3 seconds)
8. Waits for network to idle (AJAX requests complete)
9. Waits 1 additional second for JavaScript rendering
10. **Returns the fully RENDERED DOM** (not raw HTML source)
    - Includes all JavaScript-generated content
    - Includes all AJAX-loaded content
    - Includes all dynamically inserted elements
    - Uses `document.documentElement.outerHTML` for complete rendered state

### Dynamic Content & Infinite Scroll

The tool is specifically designed for modern web applications with dynamic content:

#### **AJAX/JavaScript Handling:**
- ✅ **Waits for network idle**: Ensures all AJAX requests complete
- ✅ **Returns rendered DOM**: Gets actual content after JavaScript execution
- ✅ **Not raw HTML source**: Uses browser's rendered output
- ✅ **Includes dynamic elements**: Captures content inserted by React, Vue, Angular, etc.

#### **Infinite Scroll Support:**
- ✅ **Scrolls to bottom**: Triggers lazy-loading mechanisms
- ✅ **Detects new content**: Monitors page height changes
- ✅ **Smart waiting**: Exits early when content loads
- ✅ **Multiple fallbacks**: Keyboard scroll if JavaScript fails

#### **Perfect for:**
- Single Page Applications (React, Vue, Angular)
- Infinite scroll feeds (Twitter, Facebook, LinkedIn)
- Lazy-loaded images and content
- AJAX-powered content (search results, filters)
- Dynamic dashboards and admin panels

**Tips for best results:**
- Set `scrolls` to 5-10 to load multiple pages of content
- Use `scrollWaitTime` of 1000-3000ms for slow-loading content (default: 1000ms)
- Increase `initialWaitTime` to 5000+ if page has heavy initialization
- For SPAs, allow time for initial JavaScript bootstrap
- Use `cleanup: true` to extract only meaningful text content without scripts, styles, and visual elements
- Use `cleanup: false` (default) to get the full rendered HTML

## MCP Client Configuration

Add to your MCP client configuration (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "digest": {
      "command": "node",
      "args": ["/path/to/digest-mcp/build/index.js"],
      "env": {
        "BROWSERLESS_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## License

ISC

