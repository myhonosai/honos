import { describe, expect, it } from 'vitest';
import {
  assertWorkItemTransition,
  canTransitionWorkItem,
  isTerminalWorkItemStatus,
  isWorkItemStatus,
} from '../src/index.js';

describe('work item state transition policy', () => {
  it('recognizes the complete closed status vocabulary', () => {
    expect(isWorkItemStatus('READY')).toBe(true);
    expect(isWorkItemStatus('WAITING_FOR_APPROVAL')).toBe(true);
    expect(isWorkItemStatus('COMPLETED')).toBe(true);
    expect(isWorkItemStatus('UNKNOWN')).toBe(false);
  });

  it('allows a conservative active-work progression', () => {
    expect(assertWorkItemTransition('READY', 'THINKING')).toBe('THINKING');
    expect(assertWorkItemTransition('THINKING', 'WORKING')).toBe('WORKING');
    expect(assertWorkItemTransition('WORKING', 'WAITING_FOR_APPROVAL')).toBe('WAITING_FOR_APPROVAL');
    expect(assertWorkItemTransition('WAITING_FOR_APPROVAL', 'WORKING')).toBe('WORKING');
    expect(assertWorkItemTransition('WORKING', 'COMPLETED')).toBe('COMPLETED');
  });

  it('requires explicit triage before resuming attention-needed work', () => {
    expect(canTransitionWorkItem('NEEDS_ATTENTION', 'READY')).toBe(true);
    expect(canTransitionWorkItem('NEEDS_ATTENTION', 'WORKING')).toBe(false);
    expect(() => assertWorkItemTransition('NEEDS_ATTENTION', 'WORKING'))
      .toThrow('WORK_ITEM_TRANSITION_DENIED');
  });

  it('does not allow shortcuts or same-state no-op transitions', () => {
    expect(canTransitionWorkItem('READY', 'COMPLETED')).toBe(false);
    expect(canTransitionWorkItem('READY', 'READY')).toBe(false);
    expect(() => assertWorkItemTransition('READY', 'COMPLETED'))
      .toThrow('WORK_ITEM_TRANSITION_DENIED');
  });

  it('never silently reopens terminal work', () => {
    expect(isTerminalWorkItemStatus('COMPLETED')).toBe(true);
    expect(isTerminalWorkItemStatus('FAILED')).toBe(true);
    expect(() => assertWorkItemTransition('COMPLETED', 'READY'))
      .toThrow('WORK_ITEM_TERMINAL_REOPEN_DENIED');
    expect(() => assertWorkItemTransition('FAILED', 'WORKING'))
      .toThrow('WORK_ITEM_TERMINAL_REOPEN_DENIED');
  });
});
