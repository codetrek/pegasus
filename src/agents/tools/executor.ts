/**
 * ToolExecutor - executes tools with validation, timeout, and event publishing.
 *
 * Event emission:
 *   - TOOL_CALL_REQUESTED (400): emitted immediately when execution begins
 *   - TOOL_CALL_COMPLETED (410) / TOOL_CALL_FAILED (420): emitted via
 *     emitCompletion() AFTER execute() returns, NOT inside execute().
 *     The caller is responsible for emitting these events after it has
 *     finished updating context.
 *     This avoids a race condition where the EventBus consumes the
 *     completion event before the caller has updated state.
 */

import type { Event } from "../events/index.ts";
import type { ToolResult, ToolContext } from "./types.ts";
import {
  ToolNotFoundError,
  ToolValidationError,
  ToolTimeoutError,
} from "./errors.ts";
import { EventType as ET, createEvent } from "../events/types.ts";
import { getLogger } from "../../infra/logger.ts";
import { MAX_TOOL_TIMEOUT } from "./background.ts";

const logger = getLogger("tools.executor");

export class ToolExecutor {
  constructor(
    private registry: { get(name: string): unknown; updateCallStats(name: string, duration: number, success: boolean): void },
    private bus: { emit(event: Event): Promise<void> | void },
    private timeout: number = 30000,
  ) {}

  /**
   * Execute a tool with validation and timeout.
   *
   * Emits TOOL_CALL_REQUESTED at the start.  Does NOT emit
   * TOOL_CALL_COMPLETED / TOOL_CALL_FAILED — the caller should call
   * emitCompletion() after updating any dependent state.
   */
  async execute(
    toolName: string,
    params: unknown,
    context: ToolContext,
    options?: { timeout?: number },
  ): Promise<ToolResult> {
    const startedAt = Date.now();

    logger.info(
      { toolName, agentId: context.agentId, params },
      "tool_execute_start",
    );

    // Emit TOOL_CALL_REQUESTED event
    this.bus.emit(
      createEvent(ET.TOOL_CALL_REQUESTED, {
        source: "tools.executor",
        taskId: context.agentId,
        payload: { toolName, params },
      })
    );

    try {
      // Validate tool exists
      const tool = this.registry.get(toolName);
      if (!tool) {
        throw new ToolNotFoundError(toolName);
      }

      // Validate parameters
      const validatedParams = (tool as { parameters: { parse: (p: unknown) => unknown } }).parameters.parse(params);

      // Execute with timeout (per-call override takes precedence, capped at MAX_TOOL_TIMEOUT)
      const effectiveTimeout = options?.timeout
        ? Math.min(options.timeout, MAX_TOOL_TIMEOUT)
        : this.timeout;

      const result = await this.executeWithTimeout(
        tool as { execute: (params: unknown, context: ToolContext) => Promise<ToolResult>; name: string },
        validatedParams,
        context,
        effectiveTimeout,
      );

      const durationMs = Date.now() - startedAt;

      // Update call statistics
      this.registry.updateCallStats(
        toolName,
        result.durationMs ?? 0,
        result.success,
      );

      logger.info(
        { toolName, agentId: context.agentId, success: true, durationMs },
        "tool_execute_done",
      );

      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorResult: ToolResult = {
        success: false,
        error: errorMessage,
        startedAt,
        completedAt: Date.now(),
        durationMs,
      };

      // Update call statistics
      this.registry.updateCallStats(toolName, durationMs, false);

      logger.error(
        { toolName, agentId: context.agentId, durationMs, error: errorMessage },
        "tool_execute_error",
      );

      return errorResult;
    }
  }

  /**
   * Emit TOOL_CALL_COMPLETED or TOOL_CALL_FAILED event.
   *
   * Call this AFTER execute() returns so that
   * downstream listeners see up-to-date state when processing the event.
   */
  emitCompletion(
    toolName: string,
    result: ToolResult,
    context: ToolContext,
  ): void {
    if (result.success) {
      this.bus.emit(
        createEvent(ET.TOOL_CALL_COMPLETED, {
          source: "tools.executor",
          taskId: context.agentId,
          payload: { toolName, result: result.result, durationMs: result.durationMs },
        })
      );
    } else {
      this.bus.emit(
        createEvent(ET.TOOL_CALL_FAILED, {
          source: "tools.executor",
          taskId: context.agentId,
          payload: { toolName, error: result.error },
        })
      );
    }
  }

  /**
   * Execute a tool with timeout protection.
   */
  private async executeWithTimeout(
    tool: { execute: (params: unknown, context: ToolContext) => Promise<ToolResult>; name: string },
    params: unknown,
    context: ToolContext,
    timeout: number,
  ): Promise<ToolResult> {
    const resultPromise = tool.execute(params, context);
    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<ToolResult>((_, reject) => {
      timerId = setTimeout(() => reject(new ToolTimeoutError(tool.name, timeout)), timeout);
    });

    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);
      clearTimeout(timerId!);
      return result as ToolResult;
    } catch (error) {
      clearTimeout(timerId!);
      if (error instanceof ToolTimeoutError) {
        throw error;
      }
      if (error && typeof error === "object" && "issues" in error) {
        throw new ToolValidationError(tool.name, error);
      }
      throw error;
    }
  }
}
