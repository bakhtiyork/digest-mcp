#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configuration Constants
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
const BROWSERLESS_WS_ENDPOINT = `wss://production-sfo.browserless.io/stealth?token=${BROWSERLESS_API_KEY}`;

// Timing Constants (in milliseconds)
const TIMEOUTS = {
  PAGE_LOAD: 30000,
  PAGE_STABILIZATION: 1000,
  SCROLL_COMPLETION: 500,
  CONTENT_CHECK_INTERVAL: 500,
  ADDITIONAL_CONTENT_WAIT: 1000,
  NETWORK_IDLE: 5000,
  NETWORK_IDLE_TIME: 500,
  FINAL_RENDER_WAIT: 1000,
} as const;

// Default Values
const DEFAULTS = {
  INITIAL_WAIT: 3000,
  SCROLL_COUNT: 0,
  SCROLL_WAIT: 3000,
} as const;

// Error Keywords for Page Detachment Detection
const PAGE_DETACHMENT_KEYWORDS = ['detached', 'closed', 'Target closed'] as const;

// Validate required environment variables
if (!BROWSERLESS_API_KEY) {
  console.error('Error: BROWSERLESS_API_KEY environment variable is not set');
  process.exit(1);
}

interface FetchWebContentArgs {
  url: string;
  initialWaitTime?: number;
  scrollCount?: number;
  scrollWaitTime?: number;
}

// Simple logger utility
const log = {
  info: (message: string, ...args: unknown[]) => console.error(`[Browserless] ${message}`, ...args),
  error: (message: string, ...args: unknown[]) => console.error(`[Browserless] ${message}`, ...args),
};

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
          initialWaitTime: z.number().optional().default(DEFAULTS.INITIAL_WAIT).describe('Time to wait (in milliseconds) after loading the page before scrolling'),
          scrollCount: z.number().optional().default(DEFAULTS.SCROLL_COUNT).describe('Number of times to scroll down the page'),
          scrollWaitTime: z.number().optional().default(DEFAULTS.SCROLL_WAIT).describe('Time to wait (in milliseconds) between each scroll action'),
        },
        outputSchema: {
          content: z.string().describe('The fully rendered DOM HTML content including all dynamically loaded elements'),
        },
      },
      async (args) => this.handleWebContentRequest(args)
    );
  }

  private async handleWebContentRequest(args: FetchWebContentArgs) {
    if (!args.url) {
      throw new McpError(ErrorCode.InvalidParams, 'URL is required');
    }

    try {
      const content = await this.fetchWebContent(args);
      
      return {
        content: [{ type: 'text' as const, text: content }],
        structuredContent: { content },
      };
    } catch (error) {
      const errorMessage = this.formatError(error);
      log.error('Tool Error:', errorMessage);
      throw new McpError(ErrorCode.InternalError, `Failed to fetch web content: ${errorMessage}`);
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.message}${error.stack ? '\n' + error.stack : ''}`;
    }
    if (typeof error === 'object' && error !== null) {
      return JSON.stringify(error, null, 2);
    }
    return String(error);
  }

  private async fetchWebContent(args: FetchWebContentArgs): Promise<string> {
    const {
      url,
      initialWaitTime = DEFAULTS.INITIAL_WAIT,
      scrollCount = DEFAULTS.SCROLL_COUNT,
      scrollWaitTime = DEFAULTS.SCROLL_WAIT,
    } = args;

    log.info(`Fetching: ${url}, initialWait: ${initialWaitTime}ms, scrolls: ${scrollCount}, scrollWait: ${scrollWaitTime}ms`);

    let page: Page | null = null;

    try {
      await this.ensureBrowserConnection();
      page = await this.createPage();
      await this.navigateToUrl(page, url);
      await this.waitForInitialLoad(initialWaitTime);
      await this.performScrolling(page, scrollCount, scrollWaitTime);
      await this.waitForNetworkAndRendering(page, scrollCount, scrollWaitTime);
      
      const content = await this.extractPageContent(page);
      await this.closePage(page);
      
      log.info('Content fetched successfully');
      return content;
    } catch (error) {
      await this.closePage(page);
      throw error;
    }
  }

  private async ensureBrowserConnection(): Promise<void> {
    if (this.browser) return;

    log.info('Connecting to browserless.io...');
    try {
      this.browser = await puppeteer.connect({
        browserWSEndpoint: BROWSERLESS_WS_ENDPOINT,
      });
      log.info('Connected successfully');
    } catch (error) {
      log.error('Connection failed:', error);
      throw new Error(`Failed to connect to browserless.io: ${this.formatError(error)}`);
    }
  }

  private async createPage(): Promise<Page> {
    if (!this.browser) {
      throw new Error('Browser not connected');
    }

    log.info('Creating new page...');
    const page = await this.browser.newPage();
    log.info('Page created');
    return page;
  }

  private async navigateToUrl(page: Page, url: string): Promise<void> {
    log.info(`Loading page: ${url}`);
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUTS.PAGE_LOAD,
      });
      log.info('Page loaded successfully');
      await this.sleep(TIMEOUTS.PAGE_STABILIZATION);
    } catch (error) {
      log.error('Failed to load page:', error);
      throw new Error(`Failed to load URL ${url}: ${this.formatError(error)}`);
    }
  }

  private async waitForInitialLoad(waitTime: number): Promise<void> {
    if (waitTime > 0) {
      log.info(`Waiting ${waitTime}ms after page load`);
      await this.sleep(waitTime);
    }
  }

  private async performScrolling(page: Page, scrollCount: number, scrollWaitTime: number): Promise<void> {
    for (let i = 0; i < scrollCount; i++) {
      if (page.isClosed()) {
        log.info('Page was closed, stopping scrolling');
        break;
      }

      log.info(`Scrolling down (${i + 1}/${scrollCount})`);
      
      try {
        const previousHeight = await this.getScrollHeight(page);
        await this.scrollToBottom(page);
        await this.sleep(TIMEOUTS.SCROLL_COMPLETION);
        await this.waitForNewContent(page, previousHeight, scrollWaitTime);
      } catch (error) {
        if (this.isPageDetachmentError(error)) {
          log.error('Page/Frame issue detected, stopping scrolling early');
          break;
        }
        log.error(`Scroll error (${i + 1}/${scrollCount}):`, error);
      }
    }
  }

  private async getScrollHeight(page: Page): Promise<number> {
    try {
      return await page.evaluate(() => document.documentElement.scrollHeight);
    } catch (error) {
      log.info('Could not get scroll height, using fallback');
      return 0;
    }
  }

  private async scrollToBottom(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: 'smooth',
        });
      });
    } catch (error) {
      log.info('Evaluate failed, using keyboard scroll');
      await page.keyboard.press('End');
    }
  }

  private async waitForNewContent(page: Page, previousHeight: number, scrollWaitTime: number): Promise<void> {
    if (scrollWaitTime <= 0) return;

    const startTime = Date.now();
    let contentLoaded = false;

    while (Date.now() - startTime < scrollWaitTime) {
      try {
        const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        if (currentHeight > previousHeight) {
          log.info(`New content detected (height: ${previousHeight} -> ${currentHeight})`);
          contentLoaded = true;
          await this.sleep(TIMEOUTS.ADDITIONAL_CONTENT_WAIT);
          break;
        }
      } catch (error) {
        break; // Page might be detached
      }
      await this.sleep(TIMEOUTS.CONTENT_CHECK_INTERVAL);
    }

    if (!contentLoaded) {
      log.info('No new content detected after scroll');
    }
  }

  private async waitForNetworkAndRendering(page: Page, scrollCount: number, scrollWaitTime: number): Promise<void> {
    // Final wait after scrolling
    if (scrollCount > 0 && scrollWaitTime > 0) {
      log.info('Final wait after scrolling');
      await this.sleep(scrollWaitTime);
    }

    // Wait for network to idle
    log.info('Waiting for network to idle...');
    try {
      await page.waitForNetworkIdle({
        timeout: TIMEOUTS.NETWORK_IDLE,
        idleTime: TIMEOUTS.NETWORK_IDLE_TIME,
      });
      log.info('Network idle');
    } catch (error) {
      log.info('Network idle timeout (continuing anyway)');
    }

    // Additional wait for JavaScript rendering
    await this.sleep(TIMEOUTS.FINAL_RENDER_WAIT);
  }

  private async extractPageContent(page: Page): Promise<string> {
    log.info('Extracting rendered DOM content');

    if (page.isClosed()) {
      throw new Error('Page was closed before content extraction');
    }

    try {
      const content = await page.evaluate(() => document.documentElement.outerHTML);
      log.info(`Extracted ${content.length} characters of rendered content`);
      return content;
    } catch (error) {
      log.error('Error getting rendered content, trying fallback:', error);
      try {
        return await page.content();
      } catch (fallbackError) {
        throw new Error(`Failed to extract page content: ${this.formatError(error)}`);
      }
    }
  }

  private async closePage(page: Page | null): Promise<void> {
    if (!page) return;

    try {
      await page.close();
      log.info('Page closed successfully');
    } catch (error) {
      log.error('Error closing page (non-fatal):', error);
    }
  }

  private isPageDetachmentError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return PAGE_DETACHMENT_KEYWORDS.some(keyword => error.message.includes(keyword));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async cleanup(): Promise<void> {
    log.info('Cleaning up...');
    if (this.browser) {
      try {
        await this.browser.disconnect();
        log.info('Browser disconnected');
      } catch (error) {
        log.error('Error disconnecting browser:', error);
      }
      this.browser = null;
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log.info('Server running on stdio');
  }
}

const server = new BrowserlessServer();
server.run().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});

