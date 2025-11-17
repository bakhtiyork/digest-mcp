#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Get browserless.io API key from environment
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;

if (!BROWSERLESS_API_KEY) {
  console.error('Error: BROWSERLESS_API_KEY environment variable is not set');
  process.exit(1);
}

// Construct browserless WebSocket endpoint
const BROWSERLESS_WS_ENDPOINT = `wss://production-sfo.browserless.io/stealth?token=${BROWSERLESS_API_KEY}`;

interface FetchWebContentArgs {
  url: string;
  initialWaitTime?: number;
  scrollCount?: number;
  scrollWaitTime?: number;
}

class BrowserlessServer {
  private server: McpServer;
  private browser: Browser | null = null;

  constructor() {
    this.server = new McpServer({
      name: 'digest-mcp',
      version: '1.0.0',
    });

    this.setupToolHandlers();
    
    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.registerTool(
      'web_content',
      {
        title: 'Fetch Web Content',
        description: 'Fetch fully rendered DOM content using browserless.io. Handles AJAX/JavaScript dynamic loading. Optimized for SPAs and infinite scroll pages. Returns the complete rendered HTML after all JavaScript execution, including dynamically loaded content. Each scroll waits for page height changes and network activity to settle.',
        inputSchema: {
          url: z.string().describe('The URL to fetch'),
          initialWaitTime: z.number().optional().default(3000).describe('Time to wait (in milliseconds) after loading the page before scrolling'),
          scrollCount: z.number().optional().default(0).describe('Number of times to scroll down the page'),
          scrollWaitTime: z.number().optional().default(3000).describe('Time to wait (in milliseconds) between each scroll action'),
        },
        outputSchema: {
          content: z.string().describe('The fully rendered DOM HTML content including all dynamically loaded elements'),
        },
      },
      async (args) => {
        if (!args.url) {
          throw new McpError(ErrorCode.InvalidParams, 'URL is required');
        }

        try {
          const content = await this.fetchWebContent(args);
          const output = { content };
          
          return {
            content: [
              {
                type: 'text',
                text: content,
              },
            ],
            structuredContent: output,
          };
        } catch (error) {
          // Better error serialization
          let errorMessage = 'Unknown error';
          if (error instanceof Error) {
            errorMessage = `${error.message}${error.stack ? '\n' + error.stack : ''}`;
          } else if (typeof error === 'object' && error !== null) {
            errorMessage = JSON.stringify(error, null, 2);
          } else {
            errorMessage = String(error);
          }
          
          console.error('[Tool Error]', errorMessage);
          
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to fetch web content: ${errorMessage}`
          );
        }
      }
    );
  }

  private async fetchWebContent(args: FetchWebContentArgs): Promise<string> {
    const {
      url,
      initialWaitTime = 3000,
      scrollCount = 0,
      scrollWaitTime = 3000,
    } = args;

    console.error(`[Browserless] Fetching: ${url}, initialWait: ${initialWaitTime}ms, scrolls: ${scrollCount}, scrollWait: ${scrollWaitTime}ms`);

    let page: Page | null = null;

    try {
      // Connect to browserless if not already connected
      if (!this.browser) {
        console.error('[Browserless] Connecting to browserless.io...');
        try {
          this.browser = await puppeteer.connect({
            browserWSEndpoint: BROWSERLESS_WS_ENDPOINT,
          });
          console.error('[Browserless] Connected successfully');
        } catch (connectError) {
          console.error('[Browserless] Connection failed:', connectError);
          throw new Error(`Failed to connect to browserless.io: ${connectError instanceof Error ? connectError.message : String(connectError)}`);
        }
      }

      // Create a new page
      console.error('[Browserless] Creating new page...');
      page = await this.browser.newPage();
      console.error('[Browserless] Page created');
      
      // Navigate to the URL
      console.error(`[Browserless] Loading page: ${url}`);
      try {
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',  // Less strict than networkidle2
          timeout: 30000 
        });
        console.error('[Browserless] Page loaded successfully');
        
        // Give the page time to stabilize
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (gotoError) {
        console.error('[Browserless] Failed to load page:', gotoError);
        throw new Error(`Failed to load URL ${url}: ${gotoError instanceof Error ? gotoError.message : String(gotoError)}`);
      }
      
      // Initial wait
      if (initialWaitTime > 0) {
        console.error(`[Browserless] Waiting ${initialWaitTime}ms after page load`);
        await new Promise(resolve => setTimeout(resolve, initialWaitTime));
      }
      
      // Scroll down the specified number of times
      // For dynamic/endless scroll pages, we scroll to bottom and wait for content to load
      for (let i = 0; i < scrollCount; i++) {
        console.error(`[Browserless] Scrolling down (${i + 1}/${scrollCount})`);
        
        try {
          // Check if page is still attached before scrolling
          if (page.isClosed()) {
            console.error('[Browserless] Page was closed, stopping scrolling');
            break;
          }
          
          // Get current scroll height before scrolling
          let previousHeight = 0;
          try {
            previousHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          } catch (e) {
            console.error('[Browserless] Could not get scroll height, using keyboard fallback');
          }
          
          // Scroll to bottom - this triggers lazy loading on most infinite scroll pages
          // Use multiple methods for maximum compatibility
          try {
            await page.evaluate(() => {
              window.scrollTo({
                top: document.documentElement.scrollHeight,
                behavior: 'smooth'
              });
            });
          } catch (evalError) {
            // Fallback to keyboard if evaluate fails (detached frame)
            console.error('[Browserless] Evaluate failed, using keyboard scroll');
            await page.keyboard.press('End');
          }
          
          // Wait for initial scroll to complete
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Wait for new content to load (check if page height increased)
          if (scrollWaitTime > 0) {
            const startTime = Date.now();
            let contentLoaded = false;
            
            while (Date.now() - startTime < scrollWaitTime) {
              try {
                const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                if (currentHeight > previousHeight) {
                  console.error(`[Browserless] New content detected (height: ${previousHeight} -> ${currentHeight})`);
                  contentLoaded = true;
                  // Give a bit more time for any additional content
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  break;
                }
              } catch (e) {
                // Page might be detached, just wait the remaining time
                break;
              }
              // Check every 500ms
              await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            if (!contentLoaded) {
              console.error('[Browserless] No new content detected after scroll');
            }
          }
          
        } catch (scrollError) {
          console.error(`[Browserless] Scroll error (${i + 1}/${scrollCount}):`, scrollError);
          // If scrolling fails, just stop and return what we have
          if (scrollError instanceof Error && 
              (scrollError.message.includes('detached') || 
               scrollError.message.includes('closed') ||
               scrollError.message.includes('Target closed'))) {
            console.error('[Browserless] Page/Frame issue detected, stopping scrolling early');
            break;
          }
          // For other errors, try to continue
        }
      }
      
      // Final wait after scrolling
      if (scrollCount > 0 && scrollWaitTime > 0) {
        console.error(`[Browserless] Final wait after scrolling`);
        await new Promise(resolve => setTimeout(resolve, scrollWaitTime));
      }
      
      // Wait for any pending network requests to complete
      console.error('[Browserless] Waiting for network to idle...');
      try {
        await page.waitForNetworkIdle({ timeout: 5000, idleTime: 500 });
        console.error('[Browserless] Network idle');
      } catch (networkError) {
        console.error('[Browserless] Network idle timeout (continuing anyway)');
      }
      
      // Additional wait for any JavaScript rendering
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get the RENDERED DOM content (not raw HTML source)
      // This includes all dynamically loaded content from AJAX/JavaScript
      console.error('[Browserless] Extracting rendered DOM content');
      let content: string;
      
      try {
        if (page.isClosed()) {
          throw new Error('Page was closed before content extraction');
        }
        
        // Extract the fully rendered DOM including all JavaScript modifications
        content = await page.evaluate(() => {
          // Get the complete rendered HTML including all dynamic content
          return document.documentElement.outerHTML;
        });
        
        console.error(`[Browserless] Extracted ${content.length} characters of rendered content`);
        
      } catch (contentError) {
        console.error('[Browserless] Error getting rendered content:', contentError);
        // Fallback to raw HTML if evaluate fails
        try {
          console.error('[Browserless] Trying fallback to raw HTML...');
          content = await page.content();
        } catch (fallbackError) {
          throw new Error(`Failed to extract page content: ${contentError instanceof Error ? contentError.message : String(contentError)}`);
        }
      }
      
      // Close the page
      try {
        await page.close();
        console.error('[Browserless] Page closed successfully');
      } catch (closeError) {
        console.error('[Browserless] Error closing page (non-fatal):', closeError);
      }
      
      console.error('[Browserless] Content fetched successfully');
      return content;
      
    } catch (error) {
      // Clean up page on error
      if (page) {
        try {
          await page.close();
        } catch (e) {
          console.error('[Browserless] Error closing page:', e);
        }
      }
      throw error;
    }
  }

  private async cleanup() {
    console.error('[Browserless] Cleaning up...');
    if (this.browser) {
      try {
        await this.browser.disconnect();
        console.error('[Browserless] Browser disconnected');
      } catch (error) {
        console.error('[Browserless] Error disconnecting browser:', error);
      }
      this.browser = null;
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Digest MCP server running on stdio');
  }
}

const server = new BrowserlessServer();
server.run().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});

