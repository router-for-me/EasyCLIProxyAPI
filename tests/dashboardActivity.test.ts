import { describe, expect, it } from 'bun:test';
import { accountRequests, requestClient, successfulRequest, privateText, type DashboardRequest } from '../src/services/dashboardActivity';
const request: DashboardRequest = { timestamp: '2026-10-02T21:24:00Z', auth_index: 'second', model: 'claude-sonnet-5', failed: false, canceled: false, user_agent: 'claude-cli/2.1 (external, claude-desktop-3p)' };
describe('dashboard activity attribution', () => {
  it('matches account IDs instead of shared names', () => {
    expect(accountRequests({ name: 'same', auth_index: 'first' }, [request])).toEqual([]);
    expect(accountRequests({ name: 'same', auth_index: 'second' }, [request])).toEqual([request]);
    expect(accountRequests({ name: 'same' }, [{ ...request, auth_index: undefined }])).toEqual([]);
  });
  it('does not label cancellations or failed requests as successful', () => {
    expect(successfulRequest(request)).toBe(true);
    expect(successfulRequest({ ...request, canceled: true })).toBe(false);
    expect(successfulRequest({ ...request, failed: true })).toBe(false);
  });
  it('distinguishes Desktop from CLI and leaves unidentified clients unknown', () => {
    expect(requestClient(request)).toBe('Claude Desktop');
    expect(requestClient({ ...request, user_agent: 'claude-cli/2.1' })).toBe('Claude Code CLI');
    expect(requestClient({ ...request, user_agent: '' })).toBeNull();
  });
  it('masks addresses in supplemental text', () => {
    expect(privateText('Account person@example.com failed', true)).not.toContain('person@example.com');
    expect(privateText('person@example.com', false)).toBe('person@example.com');
  });
});
