import { describe, expect, it } from 'vitest';
import { loadToolDefinition, McpToolRegistry } from './mcp-tool-registry.js';
import type { McpTool } from './mcp.types.js';

const fake = (name: string): McpTool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  run: () => Promise.resolve({}),
});

describe('McpToolRegistry', () => {
  it('liệt kê theo thứ tự tên và tìm theo tên', () => {
    const registry = new McpToolRegistry();
    registry.register(fake('b'));
    registry.register(fake('a'));
    expect(registry.list().map((t) => t.name)).toEqual(['a', 'b']);
    expect(registry.get('a')?.name).toBe('a');
    expect(registry.get('zzz')).toBeUndefined();
  });

  it('từ chối tool trùng tên', () => {
    const registry = new McpToolRegistry();
    registry.register(fake('a'));
    expect(() => registry.register(fake('a'))).toThrow('trùng tên');
  });
});

describe('loadToolDefinition', () => {
  it('đọc whoami từ contract (@teamlens/schema/mcp/whoami.json)', () => {
    const def = loadToolDefinition('whoami');
    expect(def.name).toBe('whoami');
    expect(def.inputSchema.type).toBe('object');
    expect(def.outputSchema.type).toBe('object');
  });
});
