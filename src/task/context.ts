/**
 * TaskContext — accumulates all intermediate artifacts for a task.
 */

import type { Message } from "../infra/llm-types.ts";
import { shortId } from "../infra/id.ts";

// ── PlanStep ─────────────────────────────────────────

export interface PlanStep {
  index: number;
  description: string;
  actionType: string; // "tool_call" | "generate" | "sub_task"
  actionParams: Record<string, unknown>;
  completed: boolean;
}

// ── Plan ─────────────────────────────────────────────

export interface Plan {
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

export function currentStep(plan: Plan): PlanStep | null {
  return plan.steps.find((s) => !s.completed) ?? null;
}

export function hasMoreSteps(plan: Plan): boolean {
  return plan.steps.some((s) => !s.completed);
}

export function markStepDone(plan: Plan, index: number): void {
  const step = plan.steps.find((s) => s.index === index);
  if (step) step.completed = true;
}

// ── ActionResult ─────────────────────────────────────

export interface ActionResult {
  stepIndex: number;
  actionType: string;
  actionInput: Record<string, unknown>;
  result?: unknown;
  success: boolean;
  error?: string;
  startedAt: number; // Unix ms
  completedAt?: number;
  durationMs?: number;
}

// ── Reflection ───────────────────────────────────────

export interface Reflection {
  verdict: "complete" | "continue" | "replan";
  assessment: string;
  lessons: string[];
  nextFocus?: string;
}

/** Output of async post-task reflection (M4). */
export interface PostTaskReflection {
  assessment: string;
  toolCallsCount: number;
}

// ── TaskContext ───────────────────────────────────────

export interface TaskContext {
  // Task identifier
  id: string;

  // Short summary for task list readability
  description: string;

  // Original input
  inputText: string;
  inputMetadata: Record<string, unknown>;
  source: string;

  // Task type (AI task specialization)
  taskType: string;

  // Cognitive stage outputs
  reasoning: Record<string, unknown> | null;
  plan: Plan | null;
  actionsDone: ActionResult[];
  reflections: Reflection[];
  postReflection?: PostTaskReflection | null;

  // Loop control
  iteration: number;

  // Final result
  finalResult: unknown | null;
  error: string | null;

  // Suspend/resume
  suspendedState: string | null;
  suspendReason: string | null;

  // Conversation history
  messages: Message[];

  // Whether memory index has been injected into this task's conversation
  memoryIndexInjected: boolean;
}

export function createTaskContext(
  opts: {
    id?: string;
    description?: string;
    inputText?: string;
    inputMetadata?: Record<string, unknown>;
    source?: string;
    taskType?: string;
  } = {},
): TaskContext {
  return {
    id: opts.id ?? shortId(),
    description: opts.description ?? "",
    inputText: opts.inputText ?? "",
    inputMetadata: opts.inputMetadata ?? {},
    source: opts.source ?? "",
    taskType: opts.taskType ?? "general",
    reasoning: null,
    plan: null,
    actionsDone: [],
    reflections: [],
    iteration: 0,
    finalResult: null,
    error: null,
    suspendedState: null,
    suspendReason: null,
    messages: [],
    memoryIndexInjected: false,
  };
}

/**
 * Prepare a TaskContext for resumption with new instructions.
 * Clears stale cognitive artifacts while preserving conversation history.
 */
export function prepareContextForResume(context: TaskContext, newInput: string): void {
  // Clear stale cognitive state — old plan/reasoning are done
  context.plan = null;
  context.reasoning = null;
  context.finalResult = null;
  context.error = null;
  context.suspendedState = null;
  context.suspendReason = null;
  context.iteration = 0;
  context.postReflection = null;

  // Preserve: context.messages, context.actionsDone — core value of resume

  // Append new instruction as user message
  context.messages.push({ role: "user", content: newInput });

  // Update inputText to reflect the new task input
  context.inputText = newInput;
}
