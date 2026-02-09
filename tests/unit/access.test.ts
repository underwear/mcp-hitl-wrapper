import { describe, it, expect } from 'vitest';
import { checkToolAccess, filterAllowedTools } from '../../src/mcp/access.js';

describe('checkToolAccess', () => {
  describe('wildcard mode (tools: "*")', () => {
    it('should allow any tool', () => {
      expect(checkToolAccess('*', 'chat_postMessage')).toBe('allowed');
      expect(checkToolAccess('*', 'delete_repo')).toBe('allowed');
      expect(checkToolAccess('*', 'anything')).toBe('allowed');
    });
  });

  describe('allow mode (whitelist)', () => {
    const config = { allow: ['search', 'get_issue', 'create_issue'] };

    it('should allow listed tools', () => {
      expect(checkToolAccess(config, 'search')).toBe('allowed');
      expect(checkToolAccess(config, 'get_issue')).toBe('allowed');
      expect(checkToolAccess(config, 'create_issue')).toBe('allowed');
    });

    it('should block unlisted tools', () => {
      expect(checkToolAccess(config, 'delete_issue')).toBe('blocked');
      expect(checkToolAccess(config, 'bulk_update')).toBe('blocked');
    });
  });

  describe('block mode (blocklist)', () => {
    const config = { block: ['delete_repo', 'delete_branch'] };

    it('should block listed tools', () => {
      expect(checkToolAccess(config, 'delete_repo')).toBe('blocked');
      expect(checkToolAccess(config, 'delete_branch')).toBe('blocked');
    });

    it('should allow unlisted tools', () => {
      expect(checkToolAccess(config, 'create_issue')).toBe('allowed');
      expect(checkToolAccess(config, 'list_repos')).toBe('allowed');
    });
  });
});

describe('filterAllowedTools', () => {
  it('should filter tools based on allow list', () => {
    const config = { allow: ['search', 'get_issue'] };
    const tools = ['search', 'get_issue', 'delete_issue', 'bulk_update'];
    expect(filterAllowedTools(config, tools)).toEqual(['search', 'get_issue']);
  });

  it('should filter tools based on block list', () => {
    const config = { block: ['delete_repo'] };
    const tools = ['create_issue', 'delete_repo', 'list_repos'];
    expect(filterAllowedTools(config, tools)).toEqual(['create_issue', 'list_repos']);
  });

  it('should return all tools for wildcard', () => {
    const tools = ['a', 'b', 'c'];
    expect(filterAllowedTools('*', tools)).toEqual(tools);
  });
});
